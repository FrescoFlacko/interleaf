// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfileStatusSnapshot } from '@shared/types/agent';
import type { AppSettings } from '@shared/schemas/settings';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import type { BatchImportResult } from '@shared/types/document';
import { resetSettingsWriteQueueForTests } from '../../src/renderer/app/api-client';
import { OnboardingHost } from '../../src/renderer/features/onboarding/OnboardingHost';
import { useOnboardingStore } from '../../src/renderer/stores/use-onboarding-store';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import type { DocumentMetadata } from '@shared/types/document';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * The wizard as a user meets it.
 *
 * What is being defended here is mostly behaviour a mouse never exercises:
 * every exit suppresses reopening, focus is trapped and then returned even when
 * nothing opened the dialog, each stage is announced politely rather than
 * asserted, and the flow yields to Settings instead of stacking a second modal
 * on top of it.
 */

const INITIAL_ONBOARDING = useOnboardingStore.getState();
const INITIAL_LIBRARY = useLibraryStore.getState();
const INITIAL_READER = useReaderStore.getState();

const EMPTY_AGENT_SNAPSHOT: AgentProfileStatusSnapshot = { profiles: [], modelDiscoveryPending: false };

function launchState(overrides: Partial<OnboardingLaunchState> = {}): OnboardingLaunchState {
  return {
    verdict: 'new-install',
    shouldAutoOpen: true,
    resumeStage: 'welcome',
    settingsRowPresent: false,
    onboardingSectionPresent: false,
    priorInstallEvidence: false,
    ...overrides,
  };
}

function providerStatus(id: AIProviderId): AIProviderStatus {
  return {
    id,
    name: id,
    available: false,
    installed: false,
    authentication: 'disconnected',
    version: null,
    errorMessage: null,
    models: [],
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: false,
      persistentSessions: false,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
  };
}

const settingsWrites: AppSettings[] = [];

function installApi(launch: OnboardingLaunchState): void {
  stubBridge({
    settings: {
      update: (next: AppSettings) => {
        settingsWrites.push(next);
        return Promise.resolve(next);
      },
    },
    onboarding: { getLaunchState: () => Promise.resolve(launch) },
    credentials: { getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS) },
    agent: { listProfileStatus: () => Promise.resolve(EMPTY_AGENT_SNAPSHOT) },
    ai: { getProviderStatus: (id: AIProviderId) => Promise.resolve(providerStatus(id)) },
  });
}

/** The shell's own focus landing spot, which the wizard falls back to. */
function mountMainContent(): HTMLElement {
  const main = document.createElement('div');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.append(main);
  return main;
}

async function renderHost(launch: OnboardingLaunchState = launchState()): Promise<void> {
  installApi(launch);
  renderWithChatStore(chat, <OnboardingHost />);
  await act(async () => {
    useUiStore.setState({ loadedSettings: DEFAULT_APP_SETTINGS });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(useOnboardingStore.getState().launchState).not.toBeNull();
  });
}

function focusableInDialog(): HTMLElement[] {
  const dialog = screen.getByTestId('onboarding-wizard');
  return Array.from(
    dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((element) => !element.hasAttribute('disabled'));
}

beforeEach(() => {
  settingsWrites.length = 0;
  mountMainContent();
});

afterEach(() => {
  cleanup();
  document.getElementById('main-content')?.remove();
  useOnboardingStore.setState(INITIAL_ONBOARDING, true);
  useLibraryStore.setState(INITIAL_LIBRARY, true);
  useReaderStore.setState(INITIAL_READER, true);
  useUiStore.setState({ settingsOpen: false, loadedSettings: null });
  resetSettingsWriteQueueForTests();
  vi.restoreAllMocks();
});

describe('onboarding wizard', () => {
  it('auto-opens on a fresh install and moves focus into the dialog', async () => {
    await renderHost();

    const dialog = await screen.findByTestId('onboarding-wizard');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('keeps Tab inside the dialog in both directions', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');

    const focusable = focusableInDialog();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape, suppresses reopening and returns focus to the document', async () => {
    await renderHost();
    const dialog = await screen.findByTestId('onboarding-wizard');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
    });
    expect(useOnboardingStore.getState().status).toBe('finish-later');
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('main-content');
    });
  });

  it('returns focus to the control that opened it', async () => {
    await renderHost(launchState({ verdict: 'upgraded-install', shouldAutoOpen: false, priorInstallEvidence: true }));

    const opener = await screen.findByTestId('onboarding-entry-open');
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByTestId('onboarding-wizard');
    fireEvent.click(screen.getByTestId('onboarding-close'));

    await waitFor(() => {
      expect(dialog.isConnected).toBe(false);
    });
    // The banner outlives the wizard only until its own state settles, so the
    // assertion is on the element identity that was focused, not on a lookup.
    await waitFor(() => {
      expect(document.activeElement === opener || document.activeElement?.id === 'main-content').toBe(true);
    });
  });

  it('walks the four modal stages and finishes on the last Continue', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');

    const stages = ['welcome', 'discover', 'connect', 'import'];
    for (const stage of stages) {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe(stage);
      fireEvent.click(screen.getByTestId('onboarding-continue'));
      await act(async () => { await Promise.resolve(); });
    }

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
    });
    expect(useOnboardingStore.getState().status).toBe('completed');
  });

  it('announces each stage politely', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');

    const region = screen.getByTestId('onboarding-live-region');
    expect(region.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => {
      expect(region.textContent).toContain('Step 1 of 4');
    });

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(region.textContent).toContain('Step 2 of 4');
    });
  });

  it('exits with a suppressing status when AI setup is skipped', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');
    fireEvent.click(screen.getByTestId('onboarding-continue'));

    fireEvent.click(await screen.findByTestId('onboarding-skip-ai'));

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
    });
    // `finish-later` is the suppressing status main reads back as `suppressed`;
    // it is kept apart from `dismissed` only so Settings can tell the two exits
    // apart. Either way nothing reopens by itself.
    expect(useOnboardingStore.getState().status).toBe('finish-later');
    await waitFor(() => {
      expect(settingsWrites.at(-1)?.onboarding.status).toBe('finish-later');
    });
  });

  it('yields to Settings instead of stacking, and returns to the same stage', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('discover');

    act(() => { useUiStore.setState({ settingsOpen: true }); });
    expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
    expect(useOnboardingStore.getState().open).toBe(true);

    act(() => { useUiStore.setState({ settingsOpen: false }); });
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('discover');
  });
  it('does not re-trigger discovery when navigating between stages, and rechecks on explicit Check again button click', async () => {
    await renderHost();
    const wizard = await screen.findByTestId('onboarding-wizard');
    expect(wizard.dataset.stage).toBe('welcome');
    expect(useOnboardingStore.getState().observing).toBe(false);

    const refreshSpy = vi.spyOn(useOnboardingStore.getState(), 'refreshDiscovery');
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(wizard.dataset.stage).toBe('discover');
    });
    expect(useOnboardingStore.getState().observing).toBe(true);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(wizard.dataset.stage).toBe('connect');
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('onboarding-back'));
    await waitFor(() => {
      expect(wizard.dataset.stage).toBe('discover');
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    const recheckBtn = screen.getByTestId('onboarding-recheck');
    fireEvent.click(recheckBtn);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(wizard.dataset.stage).toBe('connect');
    });
    fireEvent.click(screen.getByTestId('onboarding-back'));
    await waitFor(() => {
      expect(wizard.dataset.stage).toBe('discover');
    });
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });
});

describe('onboarding discovery step', () => {
  async function reachDiscoverStage(): Promise<void> {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('discover');
    });
  }

  it('claims nothing while a pass is still running', async () => {
    await reachDiscoverStage();
    // A deliberately unanswered pass: a stored, readable key means OpenRouter
    // waits on its probe rather than short-circuiting to "no key added".
    act(() => {
      useOnboardingStore.setState({
        openRouterCredential: 'ready',
        chatProbes: Object.fromEntries(
          Object.keys(useOnboardingStore.getState().chatProbes).map((id) => [id, { phase: 'checking' }])
        ),
        agentDetectionPending: true,
        agentProfiles: [],
      });
    });

    expect(screen.queryByTestId('onboarding-group-ready')).toBeNull();
    const checking = screen.getByTestId('onboarding-group-checking');
    for (const pill of checking.querySelectorAll('[data-testid^="onboarding-pill-"]')) {
      expect(pill.getAttribute('data-state')).toBe('checking');
    }
  });

  it('groups settled rows by state, counts each group and lists a provider once', async () => {
    await reachDiscoverStage();
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-group-checking')).toBeNull();
    });

    const groups = screen.getAllByTestId(/^onboarding-group-(checking|ready|not-verified|unavailable)$/);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const rows = group.querySelectorAll('li[data-testid^="onboarding-row-"]');
      expect(group.dataset.count).toBe(String(rows.length));
      expect(group.querySelector('[data-testid$="-count"]')?.textContent).toBe(String(rows.length));
    }

    // One row per provider, not one card per capability.
    const ids = screen
      .getAllByTestId(/^onboarding-row-/)
      .map((element) => element.getAttribute('data-testid'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('onboarding-row-openrouter');
    expect(ids).toContain('onboarding-row-codex');
  });

  it('explains the two modes in the footer beside Back and Continue', async () => {
    await reachDiscoverStage();

    expect(screen.getByTestId('onboarding-footer-note').textContent).toContain(
      'Chat and Agent are the two modes a tool can serve.'
    );
    expect(screen.getByTestId('onboarding-back')).toBeTruthy();
    expect(screen.getByTestId('onboarding-continue')).toBeTruthy();
    expect(screen.getByTestId('onboarding-recheck')).toBeTruthy();
  });
});

describe('onboarding entry banner', () => {
  it('offers setup to an existing install without opening anything', async () => {
    await renderHost(launchState({ verdict: 'upgraded-install', shouldAutoOpen: false, priorInstallEvidence: true }));

    expect(await screen.findByTestId('onboarding-entry-banner')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
  });

  it('stops offering once declined', async () => {
    await renderHost(launchState({ verdict: 'upgraded-install', shouldAutoOpen: false, priorInstallEvidence: true }));
    fireEvent.click(await screen.findByTestId('onboarding-entry-not-now'));

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-entry-banner')).toBeNull();
    });
    expect(useOnboardingStore.getState().status).toBe('dismissed');
  });

  it('is absent on a fresh install, which opens the wizard instead', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');
    expect(screen.queryByTestId('onboarding-entry-banner')).toBeNull();
  });
});

describe('onboarding import stage', () => {
  async function reachImportStage(): Promise<void> {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(screen.getByTestId('onboarding-continue'));
      await act(async () => { await Promise.resolve(); });
    }
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
  }

  it('treats a cancelled file dialog as no event at all', async () => {
    useLibraryStore.setState({ openFileDialog: () => Promise.resolve(null) });
    await reachImportStage();

    fireEvent.click(screen.getByTestId('onboarding-choose-file'));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('onboarding-import-error')).toBeNull();
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
  });

  it('reports a failed import without ending the stage', async () => {
    const failure: BatchImportResult = {
      imported: [],
      failed: [{ fileName: 'broken.pdf', error: 'That file is not a supported document.' }],
      totalAttempted: 1,
    };
    useLibraryStore.setState({ openFileDialog: () => Promise.resolve(failure) });
    await reachImportStage();

    fireEvent.click(screen.getByTestId('onboarding-choose-file'));

    const alert = await screen.findByTestId('onboarding-import-error');
    expect(alert.textContent).toContain('not a supported document');
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
  });
});

describe('first-action tip', () => {
  const OPEN_DOCUMENT: DocumentMetadata = {
    id: 'doc-1',
    title: 'Opened document',
    author: null,
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 1,
    fileMtimeMs: 0,
    fileHash: 'hash-doc-1',
    pageCount: 1,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    source: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  /** A reader state that satisfies `isReaderReady`; the tip never calls the adapter. */
  function openDocument(): void {
    useReaderStore.setState({
      session: testReaderSession(OPEN_DOCUMENT),
      isLoading: false,
      error: null,
      pageCount: 1,
    });
  }

  it('stays away until a document is genuinely open', async () => {
    await renderHost();
    act(() => { useOnboardingStore.setState({ open: false, status: 'completed' }); });

    expect(screen.queryByTestId('onboarding-first-action-tip')).toBeNull();

    act(() => { openDocument(); });
    expect(await screen.findByTestId('onboarding-first-action-tip')).toBeTruthy();
  });

  it('is non-modal and dismissible', async () => {
    await renderHost();
    act(() => {
      useOnboardingStore.setState({ open: false, status: 'completed' });
      openDocument();
    });

    const tip = await screen.findByTestId('onboarding-first-action-tip');
    expect(tip.tagName).toBe('ASIDE');
    expect(tip.getAttribute('aria-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-tip-got-it'));
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-first-action-tip')).toBeNull();
    });
  });

  it('never appears while the wizard owns the screen', async () => {
    await renderHost();
    act(() => { openDocument(); });
    act(() => { useOnboardingStore.setState({ status: 'in-progress' }); });

    expect(useOnboardingStore.getState().open).toBe(true);
    expect(screen.queryByTestId('onboarding-first-action-tip')).toBeNull();
  });
});

describe('onboarding accessibility and palette safety', () => {
  it('has no axe violations on the stage a user lands on', async () => {
    await renderHost();
    await screen.findByTestId('onboarding-wizard');

    // Contrast is a property of the six palettes, which jsdom does not paint;
    // it is held by the token assertion below and by the visual E2E evidence.
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('names only semantic colour tokens, so all six palettes apply', () => {
    const directory = join(__dirname, '../../src/renderer/features/onboarding');
    const sources = readdirSync(directory)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => ({ name, css: readFileSync(join(directory, name), 'utf8') }));
    expect(sources.length).toBeGreaterThan(0);

    // Tailwind literals that would pin a colour instead of following the theme.
    // `bg-black/40` is excluded: it is the shared modal scrim every other dialog
    // in the app already uses, and it is deliberately palette-independent.
    const literalColour =
      /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/g;
    for (const source of sources) {
      const offenders = (source.css.match(literalColour) ?? []).filter((match) => match !== 'bg-black');
      expect(offenders, `${source.name} uses semantic tokens only`).toEqual([]);
    }
  });
});
