// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import type { AgentProfile } from '@shared/types/agent';
import type { CustomAgentProfile, CustomAgentProfileCreateInput, CustomAgentProfileUpdateInput } from '@shared/types/custom-agent-profile';
import { storedCustomProfile } from '../helpers/custom-agent-profile';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { CustomAgentProfilesPanel } from '../../src/renderer/features/agent/CustomAgentProfilesPanel';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { chooseValue } from '../helpers/listbox-select';

describe('CustomAgentProfilesPanel', () => {
  const selectExecutable = vi.fn(() => Promise.resolve({ handle: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'agent-cli', fingerprint: 'f'.repeat(64) }));
  let storedProfiles: CustomAgentProfile[] = [];
  const listCustomProfiles = vi.fn(() => Promise.resolve<readonly CustomAgentProfile[]>(storedProfiles));
  const createCustomProfile = vi.fn((input: CustomAgentProfileCreateInput) => {
    const profile = storedCustomProfile(input, 'custom:11111111-1111-4111-8111-111111111111');
    storedProfiles = [profile];
    runtimeProfiles = [fallbackProfile(), runtimeProfile(profile.id, input.name)];
    return Promise.resolve(profile);
  });
  const updateCustomProfile = vi.fn((input: CustomAgentProfileUpdateInput) => {
    // The panel re-lists the profiles after a save and shows their names, so the
    // stored record takes the update's name and otherwise keeps the shape — and
    // the execution-kind branch — it already had.
    const rename = (profile: CustomAgentProfile): CustomAgentProfile =>
      ({ ...profile, name: input.name ?? profile.name, updatedAt: new Date().toISOString() });
    storedProfiles = storedProfiles.map((profile) => profile.id === input.id ? rename(profile) : profile);
    runtimeProfiles = runtimeProfiles.map((profile) => profile.id === input.id ? runtimeProfile(input.id, input.name ?? '') : profile);
    const saved = storedProfiles[0];
    if (!saved) throw new Error('The update was asked for before any profile was stored.');
    return Promise.resolve(saved);
  });
  const fallbackProfile = (): AgentProfile => ({
    id: 'fake', providerId: 'fake', name: 'Fake fallback', defaultModel: null, availableModels: [], reasoningEffort: null, defaultSandboxMode: 'auto-isolated',
    capabilities: { structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true, subagents: false, interactiveAuthentication: false, nonInteractiveMode: true },
    detection: { availability: 'installed', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null }, isCustom: false, unsafe: false,
  });
  const runtimeProfile = (id: string, name: string): AgentProfile => ({ ...fallbackProfile(), id, providerId: 'custom', name, isCustom: true });
  let runtimeProfiles: AgentProfile[] = [fallbackProfile()];
  const listProfiles = vi.fn(() => Promise.resolve(runtimeProfiles));
  const getModeAvailability = vi.fn(() => Promise.resolve([]));
  const deleteCustomProfile = vi.fn((id: string) => { storedProfiles = storedProfiles.filter((profile) => profile.id !== id); runtimeProfiles = runtimeProfiles.filter((profile) => profile.id !== id); return Promise.resolve(); });

  beforeEach(() => {
    vi.clearAllMocks();
    storedProfiles = [];
    runtimeProfiles = [fallbackProfile()];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubBridge(testInterleafApi({ agent: { selectExecutable, listCustomProfiles, createCustomProfile, updateCustomProfile, deleteCustomProfile, listProfiles, getModeAvailability } }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); useAgentStore.setState({ profiles: [], selectedProfileId: null, modeAvailability: [], error: null }); });

  it('explains executable selection in user terms, without internal transport vocabulary', async () => {
    const { container } = render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeTruthy(); });
    const guidance = screen.getByText(/refuses a program that has changed since you picked it/);
    expect(guidance.textContent).not.toMatch(/opaque|main-owned|IPC|renderer storage/i);
    expect(container.querySelector('[title*="opaque"]')).toBeNull();
  });

  it('exposes accessible tokenized configuration without exposing filesystem paths', async () => {
    const { container } = render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeTruthy(); });
    expect(screen.getByText('Direct program (recommended)')).toBeTruthy();
    expect(screen.getByText(/No shell is involved/)).toBeTruthy();
    expect(screen.getByText(/Expert Shell \(Dangerous, full OS user authority\)/)).toBeTruthy();
    expect(screen.getByLabelText('Custom profile argument template')).toHaveValue('--prompt\n{{promptFile}}');
    expect(container.textContent).not.toContain('/Users/');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('completes native selection, create, edit, update, and confirmed delete through the narrow API', async () => {
    render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeTruthy(); });
    fireEvent.click(screen.getByRole('button', { name: 'Choose executable…' }));
    await waitFor(() => { expect(screen.getByText('agent-cli')).toBeTruthy(); });
    fireEvent.change(screen.getByLabelText('Custom profile name'), { target: { value: 'Local agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => { expect(createCustomProfile).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(useAgentStore.getState().profiles.some((profile) => profile.id.startsWith('custom:'))).toBe(true); });
    const createPayload = createCustomProfile.mock.calls[0]?.[0];
    expect(createPayload).toMatchObject({ name: 'Local agent', executableHandle: expect.stringMatching(/^[a-f0-9-]+$/iu), argvTemplate: ['--prompt', '{{promptFile}}'], promptDeliveryMode: 'temp-file' });
    expect(createPayload).not.toHaveProperty('executablePath');
    expect(createPayload).not.toHaveProperty('shell');
    expect(screen.getByText('Local agent')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Local agent' }));
    fireEvent.change(screen.getByLabelText('Custom profile name'), { target: { value: 'Renamed agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => { expect(updateCustomProfile).toHaveBeenCalledTimes(1); });
    expect(updateCustomProfile.mock.calls[0]?.[0]).toMatchObject({ id: 'custom:11111111-1111-4111-8111-111111111111', name: 'Renamed agent' });
    expect(screen.getByText('Renamed agent')).toBeTruthy();
    expect(useAgentStore.getState().profiles.find((profile) => profile.id.startsWith('custom:'))?.name).toBe('Renamed agent');

    useAgentStore.getState().setSelectedProfile('custom:11111111-1111-4111-8111-111111111111');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Renamed agent' }));
    await waitFor(() => { expect(deleteCustomProfile).toHaveBeenCalledWith('custom:11111111-1111-4111-8111-111111111111'); });
    await waitFor(() => {
      expect(useAgentStore.getState().profiles.map((profile) => profile.id)).toEqual(['fake']);
      expect(useAgentStore.getState().selectedProfileId).toBe('fake');
    });
    expect(screen.getByRole('status')).toHaveTextContent('deleted');
  });

  it('configures model, reasoning, and resume templates with schema validation', async () => {
    render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeTruthy(); });

    fireEvent.click(screen.getByRole('button', { name: 'Choose executable…' }));
    await waitFor(() => { expect(screen.getByText('agent-cli')).toBeTruthy(); });

    fireEvent.change(screen.getByLabelText('Custom profile name'), { target: { value: 'Advanced agent' } });

    // Enable model selection and set model
    const modelCheckbox = screen.getByLabelText('Enable model selection');
    fireEvent.click(modelCheckbox);
    const modelInput = screen.getByLabelText('Custom profile default model');
    fireEvent.change(modelInput, { target: { value: 'gpt-4.5-preview' } });

    // Enable reasoning selection and set reasoning
    const reasoningCheckbox = screen.getByLabelText('Enable reasoning selection');
    fireEvent.click(reasoningCheckbox);
    const reasoningSelect = screen.getByLabelText('Custom profile reasoning effort');
    chooseValue(reasoningSelect, 'high');

    // Enable resume without template -> validation error
    const resumeCheckbox = screen.getByLabelText('Enable session resume');
    fireEvent.click(resumeCheckbox);
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Add the arguments that resume a session.');
    });

    // Provide resume template
    const resumeTextarea = screen.getByLabelText('Custom profile resume argument template');
    fireEvent.change(resumeTextarea, { target: { value: 'resume\n--session\n{{sessionId}}\n--model\n{{model}}' } });
    fireEvent.change(screen.getByLabelText('Custom profile argument template'), { target: { value: 'run\n--prompt\n{{promptFile}}\n--model\n{{model}}' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => { expect(createCustomProfile).toHaveBeenCalledTimes(1); });

    const payload = createCustomProfile.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      name: 'Advanced agent',
      defaultModel: 'gpt-4.5-preview',
      reasoningEffort: 'high',
      supportsModelSelection: true,
      supportsReasoningSelection: true,
      supportsResume: true,
      resumeCommandTemplate: ['resume', '--session', '{{sessionId}}', '--model', '{{model}}'],
    });
  });

  it('configures expert shell mode with family, static command, and honest warning', async () => {
    render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeTruthy(); });

    fireEvent.click(screen.getByRole('button', { name: 'Choose executable…' }));
    await waitFor(() => { expect(screen.getByText('agent-cli')).toBeTruthy(); });

    fireEvent.change(screen.getByLabelText('Custom profile name'), { target: { value: 'Shell agent' } });

    // Switch to Expert Shell
    const expertRadio = screen.getByLabelText(/Expert Shell/);
    fireEvent.click(expertRadio);

    // Warning must be present
    expect(screen.getByRole('alert')).toHaveTextContent(/Expert shell can do anything your account can/);
    expect(screen.getByRole('alert')).toHaveTextContent(/full account permissions/);
    expect(screen.getByRole('alert')).toHaveTextContent(/does not contain the program/);

    // Select PowerShell family
    const familySelect = screen.getByLabelText('Shell family');
    chooseValue(familySelect, 'powershell');

    // Enter shell command
    const commandTextarea = screen.getByLabelText('Static shell command');
    fireEvent.change(commandTextarea, { target: { value: './scripts/run-agent.ps1' } });

    // Enable resume
    const resumeCheckbox = screen.getByLabelText('Enable session resume');
    fireEvent.click(resumeCheckbox);
    const resumeCommandTextarea = screen.getByLabelText('Custom profile resume shell command');
    fireEvent.change(resumeCommandTextarea, { target: { value: './scripts/run-agent.ps1 -Resume' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() => { expect(createCustomProfile).toHaveBeenCalledTimes(1); });

    const payload = createCustomProfile.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      name: 'Shell agent',
      executionKind: 'expert-shell',
      shellFamily: 'powershell',
      shellCommand: './scripts/run-agent.ps1',
      resumeShellCommand: './scripts/run-agent.ps1 -Resume',
      promptDeliveryMode: 'stdin',
      supportsResume: true,
    });
  });

  it('gives every saved profile contextual row actions and passes an axe audit', async () => {
    const executable = { handle: 'a'.repeat(8) + '-b'.repeat(4) + '-c'.repeat(4) + '-d'.repeat(4) + '-e'.repeat(12), displayName: 'agent-cli', fingerprint: 'f'.repeat(64) };
    const makeStored = (id: string, name: string): CustomAgentProfile => ({
      id, name, executable, executionKind: 'normal', argvTemplate: ['--prompt'], promptDeliveryMode: 'stdin', stdoutParsingMode: 'text',
      defaultModel: null, reasoningEffort: null, supportsModelSelection: false, supportsReasoningSelection: false, supportsResume: false,
      resumeCommandTemplate: null, defaultSandboxMode: 'auto-isolated', workingDirectoryPolicy: 'select-per-run', unsafe: false, environmentOverrides: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    storedProfiles = [makeStored('custom:a', 'Alpha'), makeStored('custom:b', 'Beta')];
    runtimeProfiles = [fallbackProfile(), runtimeProfile('custom:a', 'Alpha'), runtimeProfile('custom:b', 'Beta')];
    const { container } = render(<CustomAgentProfilesPanel />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeTruthy(); expect(screen.getByText('Beta')).toBeTruthy(); });
    expect(screen.getByRole('button', { name: 'Edit Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Beta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Beta' })).toBeTruthy();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
