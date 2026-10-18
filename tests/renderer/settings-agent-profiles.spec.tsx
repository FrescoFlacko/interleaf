// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import type { AIProviderStatus } from '@shared/types/ai';
import { claudeProvider, codexProvider, expandProvider, settingsModalFixture } from '../helpers/settings-modal';
import { testAgentProfile } from '../helpers/agent-profile';
import { chooseValue, optionValues } from '../helpers/listbox-select';
import { modelListHelpText } from '../../src/renderer/features/agent/model-options';

const BANNED_JARGON = /main process|main-owned|argv|shell: false|allowlisted|bridge|Agent Profiles/i;

/** The banned phrase in the open dialog with its surrounding words, not the whole dialog. */
function jargon(): string | null {
  const match = new RegExp(`.{0,60}(?:${BANNED_JARGON.source}).{0,60}`, 'i').exec(screen.getByRole('dialog').textContent);
  return match?.[0] ?? null;
}

function openNotInstalledGroup(): void {
  const toggle = screen.queryByTestId('provider-not-installed-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}

function providerRowIds(): string[] {
  return screen.getAllByTestId(/^provider-summary-/).map((row) => (row.dataset.testid ?? '').slice('provider-summary-'.length));
}

/** Opens each provider row in turn and checks its text; returns the rows it opened. */
async function expectEveryProviderRowPlain(): Promise<string[]> {
  const seen: string[] = [];
  for (const id of providerRowIds()) {
    await expandProvider(id);
    seen.push(id);
    expect(jargon()).toBeNull();
  }
  return seen;
}

async function expectEveryRailSectionPlain(): Promise<void> {
  for (const rail of screen.getAllByTestId(/^settings-rail-/)) {
    fireEvent.click(rail);
    await waitFor(() => { expect(rail).toHaveAttribute('aria-pressed', 'true'); });
    expect(jargon()).toBeNull();
  }
}

describe('Settings agent provider profiles', () => {
  const {
    listProviders,
    listProfiles,
    refreshModels,
    updateSettings,
    onClose,
  } = settingsModalFixture();

  it('exposes bounded agent profile fields without exposing a binary path', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');
    expect(screen.getByTestId('profile-codex-binary')).toHaveValue('codex');
    expect(screen.getByTestId('profile-codex-arguments')).toHaveAttribute('data-value', 'safe');
    expect(screen.getByTestId('profile-codex-sandbox')).toHaveAttribute('data-value', 'auto-isolated');
    expect(screen.getByTestId('profile-codex-working-directory')).toHaveAttribute('data-value', 'select-per-run');
    expect(screen.queryByText('/usr/local/bin/codex')).toBeNull();

    const inheritPath = screen.getByTestId('profile-codex-env-PATH');
    expect(inheritPath).not.toBeChecked();
    fireEvent.click(inheritPath);
    expect(screen.getByTestId('profile-codex-env-PATH-action')).toHaveAttribute('data-value', 'inherit-allowlisted');
    chooseValue(screen.getByTestId('profile-codex-env-PATH-action'), 'clear');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ profiles: expect.objectContaining({ codex: expect.objectContaining({ environmentOverrides: [{ name: 'PATH', action: 'clear' }] }) }) }),
      }));
    });

    fireEvent.change(screen.getByTestId('profile-codex-model'), { target: { value: 'gpt-5-codex' } });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ profiles: expect.objectContaining({ codex: expect.objectContaining({ defaultModel: 'gpt-5-codex' }) }) }),
      }));
    });

    chooseValue(screen.getByTestId('profile-codex-sandbox'), 'isolated-copy');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ profiles: expect.objectContaining({ codex: expect.objectContaining({ sandboxMode: 'isolated-copy' }) }) }),
      }));
    });
  });

  it('commits a bounded per-profile model list and discards argv-shaped entries', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');

    const models = screen.getByTestId('profile-codex-models');
    expect(models).toHaveValue('');
    fireEvent.change(models, {
      target: { value: 'gpt-5.1-codex\n  gpt-5-codex  \n--yolo\nbad model\ngpt-5.1-codex\n' },
    });
    // Typing is never rewritten under the caret; normalization happens on blur.
    expect(models).toHaveValue('gpt-5.1-codex\n  gpt-5-codex  \n--yolo\nbad model\ngpt-5.1-codex\n');
    fireEvent.blur(models);

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({
            codex: expect.objectContaining({ models: ['gpt-5.1-codex', 'gpt-5-codex'] }),
          }),
        }),
      }));
    });
    expect(models).toHaveValue('gpt-5.1-codex\ngpt-5-codex');
    // The two argv-shaped entries are reported; the duplicate is simply collapsed.
    const rejected = screen.getByTestId('profile-codex-models-rejected');
    expect(rejected).toHaveTextContent('2 entries were discarded');
    expect(rejected).toHaveAttribute('role', 'alert');
  });

  it('describes the model list without claiming an installed CLI or borrowing another provider\'s models', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('claude-code');
    const models = screen.getByTestId('profile-claude-code-models');
    expect(models.getAttribute('placeholder')).not.toMatch(/gpt|codex/iu);
    for (const text of [modelListHelpText(['claude-sonnet-4-5'], 16), modelListHelpText([], 16)]) {
      expect(text).not.toMatch(/installed/iu);
    }
  });

  it('allows selecting xhigh reasoning effort for Claude Code and persists the preference', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    // Claude Code's profile is edited inside the Claude Code provider row.
    await expandProvider('claude-code');

    const claudeReasoning = screen.getByTestId('profile-claude-code-reasoning');
    expect(claudeReasoning).toBeInTheDocument();
    chooseValue(claudeReasoning, 'xhigh');

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({
            'claude-code': expect.objectContaining({
              reasoningEffort: 'xhigh',
            }),
          }),
        }),
      }));
    });
  });

  it('presents Pi like the other subscription-backed Reader Chat rows', async () => {
    const piProvider: AIProviderStatus = {
      id: 'pi',
      name: 'Pi',
      available: true,
      installed: true,
      authentication: 'connected',
      version: 'pi 0.84.4',
      errorMessage: null,
      models: [{
        id: 'openai-codex/gpt-5.1-codex', name: 'openai-codex/gpt-5.1-codex',
        contextWindow: 272_000, maxOutputTokens: 128_000, supportsStreaming: true,
      }],
      capabilities: {
        streaming: true, subscriptionAuth: true, apiKeyAuth: false,
        persistentSessions: false, toolFreeMode: true, hostedWebSearch: false,
      },
    };
    listProviders.mockResolvedValueOnce([claudeProvider, codexProvider, piProvider]);
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-status-pi')).toHaveTextContent('Ready');
    });
    await expandProvider('pi');

    const panel = screen.getByTestId('provider-panel-pi');
    expect(panel).toHaveTextContent('Connection');
    expect(panel).toHaveTextContent('Pi model provider subscription');
    expect(panel).toHaveTextContent('tool-free JSON mode');
    // Precise about what is disabled: web *search*. `--offline` suppresses Pi's
    // incidental traffic, but the selected remote model request still happens,
    // so the copy must not imply an offline turn.
    expect(panel).toHaveTextContent('web search disabled');
    expect(panel.textContent).not.toContain('web access');
    // The installed version is reported on the row itself, as for every CLI.
    expect(screen.getByTestId('provider-summary-pi')).toHaveTextContent('pi 0.84.4');
    // Nothing privileged is disclosed: no binary path, credential, account or
    // raw probe output, and no ChatGPT sign-in action borrowed from Codex.
    expect(panel.textContent).not.toMatch(/\/(usr|Users|opt)\//u);
    expect(panel.textContent).not.toContain('auth check');
    expect(panel.textContent).not.toContain('Agent Mode only');
    expect(panel.querySelector('[data-testid="sign-in-chatgpt-button"]')).toBeNull();
  });

  it('Defect 17: gives every supported built-in profile exactly one provider row', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('provider-summary-codex')).toBeEnabled(); });

    // Unavailable CLIs stay listed, and no selector duplicates them.
    for (const id of ['codex', 'claude-code', 'antigravity', 'opencode', 'pi']) {
      expect(screen.getAllByTestId(`provider-summary-${id}`)).toHaveLength(1);
    }
    // Copilot is not a supported built-in profile.
    expect(screen.queryByTestId('provider-summary-copilot')).toBeNull();
    expect(screen.getByTestId('provider-summary-pi')).toHaveTextContent('Pi');
    expect(screen.queryByTestId('agent-profile-selector')).toBeNull();
  });

  it('Defect 17: mounts only the expanded provider profile editor and swaps it on toggle', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');

    expect(screen.getByTestId('profile-editor-codex')).toBeInTheDocument();
    for (const other of ['claude-code', 'antigravity', 'copilot', 'opencode', 'pi']) {
      expect(screen.queryByTestId(`profile-editor-${other}`)).toBeNull();
      expect(screen.queryByTestId(`profile-${other}-binary`)).toBeNull();
    }
    expect(document.querySelectorAll('[data-testid^="profile-editor-"]')).toHaveLength(1);

    // At most one provider is open, so opening another closes this one.
    await expandProvider('antigravity');
    expect(screen.getByTestId('profile-editor-antigravity')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-editor-codex')).toBeNull();
    expect(screen.getByTestId('provider-summary-codex')).toHaveAttribute('aria-expanded', 'false');

    // A summary is a real button that also closes its own row.
    fireEvent.click(screen.getByTestId('provider-summary-antigravity'));
    expect(document.querySelectorAll('[data-testid^="profile-editor-"]')).toHaveLength(0);
  });

  it('Defect 17: preserves per-provider saved values while switching and keeps the custom surface separate', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');

    fireEvent.change(screen.getByTestId('profile-codex-model'), { target: { value: 'gpt-5.6-luna' } });
    await expandProvider('opencode');
    chooseValue(screen.getByTestId('profile-opencode-sandbox'), 'isolated-copy');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({
            opencode: expect.objectContaining({ sandboxMode: 'isolated-copy' }),
          }),
        }),
      }));
    });

    // Switching away and back keeps each profile's own staged values.
    await expandProvider('codex');
    expect(screen.getByTestId('profile-codex-model')).toHaveValue('gpt-5.6-luna');
    expect(screen.queryByTestId('profile-opencode-binary')).toBeNull();

    // Pi is always listed even though its reasoning effort is unsupported here.
    await expandProvider('pi');
    expect(screen.getByTestId('profile-pi-reasoning')).toBeDisabled();

    // Custom profiles keep their own section, with no built-in editor in it.
    fireEvent.click(screen.getByTestId('settings-rail-custom-profiles'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Your custom profiles' })).toBeInTheDocument();
    });
    expect(document.querySelectorAll('[data-testid^="profile-editor-"]')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('settings-rail-ai'));
    expect(screen.queryByRole('heading', { name: 'Your custom profiles' })).toBeNull();
  });

  it('offers the models the installed CLI reported instead of requiring a typed list', async () => {
    listProfiles.mockResolvedValueOnce((await listProfiles.getMockImplementation()?.() ?? []).map((profile) => (
      profile.id === 'codex' ? { ...profile, availableModels: ['gpt-5.1-codex', 'gpt-5.1'] } : profile
    )));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');

    const field = screen.getByTestId('profile-codex-model');
    expect(field).toHaveAttribute('role', 'combobox');
    expect(optionValues(field)).toEqual(['', 'gpt-5.1-codex', 'gpt-5.1']);
    chooseValue(field, 'gpt-5.1');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ profiles: expect.objectContaining({ codex: expect.objectContaining({ defaultModel: 'gpt-5.1' }) }) }),
      }));
    });

    // A CLI that publishes no list keeps the free-text field, so nothing that
    // only the user can know becomes unreachable.
    await expandProvider('pi');
    expect(screen.getByTestId('profile-pi-model').tagName).toBe('INPUT');
  });

  it('adopts a refreshed catalog when the user re-probes the installed CLIs', async () => {
    const base = await listProfiles.getMockImplementation()?.() ?? [];
    listProfiles.mockResolvedValueOnce(base.map((profile) => (
      profile.id === 'codex' ? { ...profile, availableModels: ['gpt-5.1-codex'] } : profile
    )));
    refreshModels.mockResolvedValueOnce(base.map((profile) => (
      profile.id === 'codex' ? { ...profile, availableModels: ['gpt-5.1-codex', 'gpt-5.2-codex'] } : profile
    )));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await expandProvider('codex');
    expect(optionValues(screen.getByTestId('profile-codex-model'))).toEqual(['', 'gpt-5.1-codex']);

    fireEvent.click(screen.getByTestId('refresh-agent-models'));
    await waitFor(() => {
      expect(optionValues(screen.getByTestId('profile-codex-model'))).toEqual(['', 'gpt-5.1-codex', 'gpt-5.2-codex']);
    });
    // The refresh carries no renderer-supplied arguments at all.
    expect(refreshModels).toHaveBeenCalledWith();
  });

  it('tells an absent agent how to install it, and that only a restart finds it', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('provider-summary-codex')).toBeEnabled(); });
    fireEvent.click(screen.getByTestId('provider-not-installed-toggle'));
    await expandProvider('cursor');
    // Detection runs once at startup; the model refresh never re-detects.
    expect(screen.getByTestId('provider-install-guidance-cursor')).toHaveTextContent('then restart Interleaf so it can find it');
    expect(screen.getByTestId('refresh-agent-models')).toHaveTextContent('Check all installed agents for new models');
    await expandProvider('codex');
    expect(screen.queryByTestId('provider-install-guidance-codex')).toBeNull();
  });

  it('describes every Settings surface in plain words, without internal process vocabulary', async () => {
    // How the app is built internally is not something a user can act on.
    // Expert Shell keeps its warnings; only the jargon is banned here.
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('provider-summary-codex')).toBeEnabled(); });
    openNotInstalledGroup();
    // Every row, installed or not, including the not-installed group.
    const seen = await expectEveryProviderRowPlain();
    expect(seen).toEqual(expect.arrayContaining(['codex', 'claude-code', 'antigravity', 'opencode', 'pi', 'cursor']));
    await expectEveryRailSectionPlain();
    fireEvent.click(screen.getByTestId('settings-rail-custom-profiles'));
    fireEvent.click(await screen.findByLabelText(/Expert Shell/));
    fireEvent.click(screen.getByLabelText('Enable session resume'));
    expect(screen.getByRole('alert')).toHaveTextContent(/full account permissions/);
    expect(jargon()).toBeNull();
  });

  it('gates the fake test profile in UI based on api.agent.listProfiles', async () => {
    // Production listProfiles omits 'fake', and the row list is built from the
    // supported built-in definitions, so a test-only agent can never appear.
    listProfiles.mockResolvedValueOnce([
      ...(await listProfiles.getMockImplementation()?.() ?? []),
      testAgentProfile('fake', 'Fake Agent'),
    ]);
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('provider-summary-codex')).toBeEnabled(); });

    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Fake Agent/i)).toBeNull();
    expect(screen.queryByTestId('provider-summary-fake')).toBeNull();
  });
});
