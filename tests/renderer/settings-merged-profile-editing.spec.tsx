// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { chooseValue, listedOptions, optionValues } from '../helpers/listbox-select';

const onClose = vi.fn();

/**
 * Opens one provider accordion row and waits for its merged profile editor.
 * The fixtures detect no CLI, so once statuses load each agent row sits in the
 * collapsed "Not installed" group, which a reader opens first.
 */
async function openProfile(id: string): Promise<void> {
  const group = await screen.findByTestId('provider-not-installed-toggle');
  if (group.getAttribute('aria-expanded') !== 'true') fireEvent.click(group);
  fireEvent.click(screen.getByTestId(`provider-summary-${id}`));
  await screen.findByTestId(`profile-editor-${id}`);
}

describe('per-provider agent profile editing (design 5d)', () => {
  const updateSettings = vi.fn((next: AppSettings) => Promise.resolve(next));
  const selectWorkingDirectory = vi.fn(() => Promise.resolve({ handle: 'wd-1', displayName: 'Projects' }));
  let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);

  beforeEach(() => {
    vi.clearAllMocks();
    settings = structuredClone(DEFAULT_APP_SETTINGS);
    stubBridge({
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter: vi.fn(),
        signInWithChatGPT: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
        testOpenRouterConnection: vi.fn(),
      },
      settings: { get: vi.fn(() => Promise.resolve(settings)), update: updateSettings },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([{ handle: 'wd-1', displayName: 'Projects' }])),
        selectWorkingDirectory,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers every built-in preference inside the provider row', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('codex');

    for (const field of ['binary', 'arguments', 'model', 'models', 'reasoning', 'permission', 'sandbox', 'working-directory', 'working-directory-default']) {
      expect(screen.getByTestId(`profile-codex-${field}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('profile-codex-env-PATH')).toBeInTheDocument();
    // The allowlisted binary is a preset, never a filesystem path.
    expect(screen.getByTestId('profile-codex-binary')).toHaveValue('codex');
    expect(screen.getByTestId('profile-editor-codex').textContent).not.toContain('/usr/');
  });

  it('warns when the unsafe Codex bypass is selected and clears the warning on return', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('codex');

    chooseValue(screen.getByTestId('profile-codex-arguments'), 'unsafe-yolo');
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/Unsafe Codex permission bypass is enabled/u);
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({ codex: expect.objectContaining({ permissionMode: 'unsafe-yolo' }) }),
        }),
      }));
    });

    chooseValue(screen.getByTestId('profile-codex-arguments'), 'safe');
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('never offers the unsafe bypass to a profile that does not support it', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('opencode');
    expect(optionValues(screen.getByTestId('profile-opencode-arguments'))).not.toContain('unsafe-yolo');
  });

  it('saves a per-profile working-directory default as an opaque handle only', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('claude-code');

    fireEvent.click(screen.getByTestId('profile-claude-code-choose-working-directory'));
    await waitFor(() => { expect(selectWorkingDirectory).toHaveBeenCalledOnce(); });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          workingDirectories: [{ handle: 'wd-1', displayName: 'Projects' }],
          defaultWorkingDirectoryByProfile: expect.objectContaining({ 'claude-code': 'wd-1' }),
        }),
      }));
    });
    // Nothing path-shaped is persisted for the directory: the handle and the
    // display name are all the renderer ever holds.
    const agentWritten = JSON.stringify(updateSettings.mock.calls.at(-1)?.[0].agent);
    expect(agentWritten).not.toContain('/');
  });

  it('shows a newly chosen directory once, immediately, under its display name', async () => {
    // Main's separately loaded capability list still predates this choice, so a
    // stale list would render the freshly saved handle twice — once as an
    // "Unavailable saved directory".
    selectWorkingDirectory.mockResolvedValueOnce({ handle: 'wd-2', displayName: 'Research' });
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('codex');

    fireEvent.click(screen.getByTestId('profile-codex-choose-working-directory'));
    const select = screen.getByTestId('profile-codex-working-directory-default');
    await waitFor(() => { expect(select.dataset.value).toBe('wd-2'); });

    const options = listedOptions(select);
    expect(options.filter((option) => option.value === 'wd-2')).toHaveLength(1);
    expect(select).toHaveTextContent('Research');
    expect(options.some((option) => option.name === 'Unavailable saved directory')).toBe(false);
  });

  it('still marks a mapped default whose saved directory is gone', async () => {
    settings.agent.defaultWorkingDirectoryByProfile = { codex: 'wd-removed' };
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('codex');

    const select = screen.getByTestId('profile-codex-working-directory-default');
    await waitFor(() => { expect(select.dataset.value).toBe('wd-removed'); });
    expect(select).toHaveTextContent('Unavailable saved directory');
  });

  it('reports a missing native chooser instead of failing silently', async () => {
    selectWorkingDirectory.mockRejectedValueOnce(new Error('directory selection failed'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('codex');

    fireEvent.click(screen.getByTestId('profile-codex-choose-working-directory'));
    expect(await screen.findByText('directory selection failed')).toBeTruthy();
  });

  it('shows Agent-Mode-only providers no Reader Chat connection block', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await openProfile('opencode');

    expect(screen.getByTestId('provider-panel-opencode')).toHaveTextContent('Agent Mode only');
    expect(screen.queryByTestId('sign-in-chatgpt-button')).toBeNull();
    // Its profile is still fully editable in the same row.
    expect(screen.getByTestId('profile-opencode-sandbox')).toBeInTheDocument();
  });
});
