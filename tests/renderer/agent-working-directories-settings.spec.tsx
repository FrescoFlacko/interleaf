// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AgentWorkingDirectoriesSettings } from '../../src/renderer/features/agent/AgentWorkingDirectoriesSettings';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { stubBridge } from '../helpers/interleaf-api';
import { chooseValue, optionNames } from '../helpers/listbox-select';

const customId = 'custom:550e8400-e29b-41d4-a716-446655440000';
const directoryOne: AgentWorkingDirectory = { handle: 'workspace-one', displayName: 'Workspace One' };
const directoryTwo: AgentWorkingDirectory = { handle: 'workspace-two', displayName: 'Workspace Two' };

const profile = (id: string, name: string): Pick<AgentProfile, 'id' | 'name'> => ({ id, name });
const baseSettings = (patch: Partial<AppSettings['agent']> = {}): AppSettings => ({
  ...structuredClone(DEFAULT_APP_SETTINGS),
  agent: { ...structuredClone(DEFAULT_APP_SETTINGS.agent), ...patch },
});

describe('AgentWorkingDirectoriesSettings', () => {
  const selectWorkingDirectory = vi.fn<() => Promise<AgentWorkingDirectory | null>>();
  let settings: AppSettings;
  let directories: readonly AgentWorkingDirectory[];
  let onChange: ReturnType<typeof vi.fn<(next: AppSettings) => void>>;

  beforeEach(() => {
    settings = baseSettings();
    directories = [];
    selectWorkingDirectory.mockReset();
    onChange = vi.fn<(next: AppSettings) => void>();
    stubBridge({ agent: { selectWorkingDirectory } });
  });
  afterEach(() => {
    cleanup();
  });

  const renderSettings = (overrides: {
    readonly appSettings?: AppSettings;
    readonly availableDirectories?: readonly AgentWorkingDirectory[];
    readonly availableProfiles?: readonly Pick<AgentProfile, 'id' | 'name'>[];
  } = {}) => render(
    <AgentWorkingDirectoriesSettings
      settings={overrides.appSettings ?? settings}
      directories={overrides.availableDirectories ?? directories}
      profiles={overrides.availableProfiles ?? [profile('codex', 'Codex'), profile(customId, 'Local Agent')]}
      onChange={onChange}
    />,
  );

  it('adds a native directory once and persists the exact safe settings projection', async () => {
    selectWorkingDirectory.mockResolvedValue(directoryOne);
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Add directory…' }));
    await waitFor(() => { expect(onChange).toHaveBeenCalledTimes(1); });
    expect(selectWorkingDirectory).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(baseSettings({ workingDirectories: [directoryOne] }));
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('agent.workingDirectories.0.canonicalPath');
  });

  it('does not persist a duplicate and reports native cancellation', async () => {
    settings = baseSettings({ workingDirectories: [directoryOne] });
    directories = [directoryOne];
    selectWorkingDirectory.mockResolvedValue(directoryOne);
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Add directory…' }));
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('already saved'); });
    expect(onChange).not.toHaveBeenCalled();

    selectWorkingDirectory.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Add directory…' }));
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('cancelled'); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes only the settings capability and clears every built-in/custom default mapping', () => {
    settings = baseSettings({
      workingDirectories: [directoryOne, directoryTwo],
      defaultWorkingDirectoryByProfile: { codex: directoryOne.handle, [customId]: directoryOne.handle },
    });
    directories = [directoryOne, directoryTwo];
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Remove global working directory Workspace One' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(baseSettings({ workingDirectories: [directoryTwo], defaultWorkingDirectoryByProfile: {} }));
    expect(selectWorkingDirectory).not.toHaveBeenCalled();
  });

  it('provides unique built-in and custom default selectors and persists both handles', () => {
    settings = baseSettings({ workingDirectories: [directoryOne, directoryTwo] });
    directories = [directoryOne, directoryTwo];
    renderSettings();

    const codexSelect = screen.getByRole('combobox', { name: 'Default working directory for Codex' });
    const customSelect = screen.getByRole('combobox', { name: 'Default working directory for Local Agent' });
    chooseValue(codexSelect, directoryOne.handle);
    chooseValue(customSelect, directoryTwo.handle);
    expect(onChange.mock.calls.at(-2)?.[0].agent.defaultWorkingDirectoryByProfile).toEqual({ codex: directoryOne.handle });
    expect(onChange.mock.calls.at(-1)?.[0].agent.defaultWorkingDirectoryByProfile).toEqual({ [customId]: directoryTwo.handle });
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('allows choosing, persisting, and clearing a global default Agent workspace', () => {
    settings = baseSettings({ workingDirectories: [directoryOne, directoryTwo] });
    directories = [directoryOne, directoryTwo];
    renderSettings();

    const defaultWorkspaceSelect = screen.getByTestId('agent-default-workspace');
    expect(defaultWorkspaceSelect).toHaveAttribute('data-value', '');

    chooseValue(defaultWorkspaceSelect, directoryOne.handle);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].agent.defaultWorkingDirectory).toBe(directoryOne.handle);

    // Clearing the saved default workspace
    cleanup();
    renderSettings({ appSettings: onChange.mock.calls[0]?.[0] ?? settings });
    chooseValue(screen.getByTestId('agent-default-workspace'), '');
    expect(onChange.mock.calls.at(-1)?.[0].agent.defaultWorkingDirectory).toBeNull();
  });
  it('marks stale saved entries and stale defaults without exposing a path, and makes them removable', () => {
    const stale = { handle: 'stale-handle', displayName: 'Old Workspace' };
    settings = baseSettings({
      workingDirectories: [stale],
      defaultWorkingDirectoryByProfile: { codex: stale.handle },
    });
    renderSettings({ appSettings: settings, availableDirectories: [], availableProfiles: [profile('codex', 'Codex')] });

    expect(screen.getByText('Unavailable:')).toBeTruthy();
    expect(optionNames(screen.getByRole('combobox', { name: 'Default working directory for Codex' }))).toContain('Unavailable — Old Workspace');
    expect(screen.getAllByText(/Old Workspace/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Users\//)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable working directory Old Workspace' }));
    expect(onChange.mock.calls[0]?.[0]).toEqual(baseSettings({ workingDirectories: [], defaultWorkingDirectoryByProfile: {} }));
  });

  it('marks a default for a removed runtime profile and allows clearing it', () => {
    settings = baseSettings({
      workingDirectories: [directoryOne],
      defaultWorkingDirectoryByProfile: { [customId]: directoryOne.handle },
    });
    directories = [directoryOne];
    renderSettings({ appSettings: settings, availableDirectories: directories, availableProfiles: [profile('codex', 'Codex')] });

    expect(screen.getByText('Default for a removed agent')).toBeTruthy();
    expect(screen.getByText(new RegExp(customId))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Remove stale runtime-profile default for profile ${customId}` }));
    expect(onChange.mock.calls[0]?.[0]).toEqual(baseSettings({ workingDirectories: [directoryOne], defaultWorkingDirectoryByProfile: {} }));
  });

  it('gives each stale profile row a contextual accessible remove label and removes only its mapping', () => {
    const firstStaleId = 'custom:550e8400-e29b-41d4-a716-446655440000';
    const secondStaleId = 'custom:6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    settings = baseSettings({
      workingDirectories: [directoryOne],
      defaultWorkingDirectoryByProfile: { [firstStaleId]: directoryOne.handle, [secondStaleId]: directoryOne.handle },
    });
    renderSettings({ appSettings: settings, availableDirectories: [directoryOne], availableProfiles: [profile('codex', 'Codex')] });

    const firstRemove = screen.getByRole('button', { name: `Remove stale runtime-profile default for profile ${firstStaleId}` });
    const secondRemove = screen.getByRole('button', { name: `Remove stale runtime-profile default for profile ${secondStaleId}` });
    expect(firstRemove).toBeTruthy();
    expect(secondRemove).toBeTruthy();
    fireEvent.click(secondRemove);
    expect(onChange.mock.calls[0]?.[0].agent.defaultWorkingDirectoryByProfile).toEqual({ [firstStaleId]: directoryOne.handle });
  });

  it('recovers a stale saved directory when the native handle is reused, refreshing projection without duplicates', async () => {
    const staleEntry = { handle: 'workspace-one', displayName: 'Workspace One' };
    settings = baseSettings({
      workingDirectories: [staleEntry],
      defaultWorkingDirectoryByProfile: { codex: staleEntry.handle },
    });
    directories = [];
    const refreshedDirectory: AgentWorkingDirectory = { handle: 'workspace-one', displayName: 'Workspace One Refreshed' };
    selectWorkingDirectory.mockResolvedValue(refreshedDirectory);

    renderSettings({ appSettings: settings, availableDirectories: directories, availableProfiles: [profile('codex', 'Codex')] });

    expect(screen.getByText('Unavailable:')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add directory…' }));
    await waitFor(() => { expect(onChange).toHaveBeenCalledTimes(1); });

    expect(onChange.mock.calls[0]?.[0]).toEqual(baseSettings({
      workingDirectories: [refreshedDirectory],
      defaultWorkingDirectoryByProfile: { codex: 'workspace-one' },
    }));
    expect(onChange.mock.calls[0]?.[0].agent.workingDirectories).toHaveLength(1);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Refreshed global working directory “Workspace One Refreshed”.');
    });
  });

  it('passes an axe audit with multiple profiles and directories', async () => {
    settings = baseSettings({ workingDirectories: [directoryOne, directoryTwo] });
    directories = [directoryOne, directoryTwo];
    const { container } = renderSettings({
      availableDirectories: directories,
      availableProfiles: [profile('codex', 'Codex'), profile('claude-code', 'Claude Code'), profile(customId, 'Local Agent')],
    });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
