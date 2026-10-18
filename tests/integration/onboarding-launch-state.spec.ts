import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { InterleafDatabase, DATABASE_FILE_NAME } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import {
  captureOnboardingLaunchEvidence,
  deriveOnboardingLaunchState,
  OnboardingLaunchStateLatch,
  type OnboardingLaunchEvidence,
} from '@main/app/onboarding-launch-state';
import { invokeChannel, registerIpcHandlers, type IpcMainLike } from '@main/ipc/dispatcher';
import type { CloneableValue, PortableRecordDraft } from '@shared/models/portable';
import { createSenderRule } from '@main/ipc/sender-validation';
import { IPC } from '@shared/constants/ipc';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import type { AgentService } from '@main/agents/agent-service';
import { makeIpcDeps } from '../helpers/ipc-deps';
import { silentLogger } from '../helpers/silent-logger';
import { unstubbed } from '../helpers/unstubbed';

/**
 * These run against a real SQLite file rather than a stub because the whole
 * contract is about ordering: the evidence the verdict depends on is destroyed
 * by `runMigrations` and by the first `SettingsRepository.get()`, and only a
 * real database reproduces that.
 */

type Store = {
  readonly directory: string;
  readonly databasePath: string;
};

function makeStore(): Store {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'interleaf-onboarding-'));
  return { directory, databasePath: path.join(directory, DATABASE_FILE_NAME) };
}

/** One launch, in the exact order `src/main/index.ts` performs it. */
function launch(
  store: Store,
  during?: (database: InterleafDatabase, settings: SettingsRepository) => void
): OnboardingLaunchState {
  const database = InterleafDatabase.open(store.databasePath);
  try {
    const evidence = captureOnboardingLaunchEvidence(database, silentLogger);
    runMigrations(database);
    const latch = new OnboardingLaunchStateLatch(deriveOnboardingLaunchState(evidence));
    const settings = new SettingsRepository(database, silentLogger);
    // Whatever main does next — including the diagnostic-logging read that
    // materializes defaults — must not be able to change the answer.
    settings.get();
    during?.(database, settings);
    return latch.get();
  } finally {
    database.close();
  }
}

/**
 * Puts a settings document on disk as a pre-onboarding build would have left
 * it. Migration 2 (`seed_default_settings`) already inserts a row of its own on
 * a fresh database, so this replaces rather than inserts.
 */
function seedSettingsDocument(store: Store, valueJson: string): void {
  const seed = InterleafDatabase.open(store.databasePath);
  runMigrations(seed);
  seed.raw.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run('app', valueJson);
  seed.close();
}

function cleanup(store: Store): void {
  rmSync(store.directory, { recursive: true, force: true });
}

describe('onboarding launch state', () => {
  it('classifies a truly fresh store as a new install and auto-opens once', () => {
    const store = makeStore();
    try {
      const first = launch(store);
      expect(first.verdict).toBe('new-install');
      expect(first.shouldAutoOpen).toBe(true);
      expect(first.settingsRowPresent).toBe(false);
      expect(first.priorInstallEvidence).toBe(false);
    } finally {
      cleanup(store);
    }
  });

  it('never auto-opens again once the database exists, even with no settings row', () => {
    const store = makeStore();
    try {
      expect(launch(store).verdict).toBe('new-install');
      const second = launch(store);
      expect(second.verdict).toBe('upgraded-install');
      expect(second.shouldAutoOpen).toBe(false);
      expect(second.priorInstallEvidence).toBe(true);
    } finally {
      cleanup(store);
    }
  });

  it('treats a settings row without an onboarding section as an upgraded install', () => {
    const store = makeStore();
    try {
      // A document written by a build that predates onboarding: every other
      // preference is present, the section is not.
      const legacy = { ...DEFAULT_APP_SETTINGS, appearance: { palette: 'sepia' } } as PortableRecordDraft;
      delete legacy.onboarding;
      seedSettingsDocument(store, JSON.stringify(legacy));

      const state = launch(store);
      expect(state.verdict).toBe('upgraded-install');
      expect(state.settingsRowPresent).toBe(true);
      expect(state.onboardingSectionPresent).toBe(false);
      expect(state.shouldAutoOpen).toBe(false);
    } finally {
      cleanup(store);
    }
  });

  it('does not rewrite or reset the existing settings document', () => {
    const store = makeStore();
    try {
      const legacy = { ...DEFAULT_APP_SETTINGS, appearance: { palette: 'moss' } } as PortableRecordDraft;
      delete legacy.onboarding;
      const stored = JSON.stringify(legacy);
      seedSettingsDocument(store, stored);

      launch(store);

      const check = InterleafDatabase.open(store.databasePath);
      const row = check.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get('app') as { value_json: string };
      check.close();
      expect(row.value_json).toBe(stored);
    } finally {
      cleanup(store);
    }
  });

  it('latches before the first settings read, so a later defaults write cannot reclassify the launch', () => {
    const store = makeStore();
    try {
      const state = launch(store, (_database, settings) => {
        // Exactly the normalization write that would otherwise destroy the
        // evidence: it happens *after* the latch, inside the same launch.
        settings.update(DEFAULT_APP_SETTINGS);
      });
      expect(state.verdict).toBe('new-install');

      // The write did land, and the next launch sees it.
      const next = launch(store);
      expect(next.settingsRowPresent).toBe(true);
      expect(next.onboardingSectionPresent).toBe(true);
      expect(next.verdict).toBe('not-started');
      expect(next.shouldAutoOpen).toBe(false);
    } finally {
      cleanup(store);
    }
  });

  it('resumes an interrupted flow at the stage after the last acknowledged one', () => {
    const store = makeStore();
    try {
      launch(store, (_database, settings) => {
        settings.update({
          ...DEFAULT_APP_SETTINGS,
          onboarding: { version: 1, status: 'in-progress', lastStageAcknowledged: 'discover', completedAt: null },
        });
      });

      const state = launch(store);
      expect(state.verdict).toBe('resume');
      expect(state.shouldAutoOpen).toBe(true);
      expect(state.resumeStage).toBe('connect');
    } finally {
      cleanup(store);
    }
  });

  it('suppresses reopening after finish-later and after completion', () => {
    for (const [status, expected] of [['finish-later', 'suppressed'], ['dismissed', 'done'], ['completed', 'done']] as const) {
      const store = makeStore();
      try {
        launch(store, (_database, settings) => {
          settings.update({
            ...DEFAULT_APP_SETTINGS,
            onboarding: {
              version: 1,
              status,
              lastStageAcknowledged: 'connect',
              completedAt: status === 'completed' ? '2026-09-15T00:00:00.000Z' : null,
            },
          });
        });

        const state = launch(store);
        expect(state.verdict).toBe(expected);
        expect(state.shouldAutoOpen).toBe(false);
      } finally {
        cleanup(store);
      }
    }
  });

  it('does not mistake the settings row seeded by migration 2 for a prior install', () => {
    const store = makeStore();
    try {
      // The evidence is captured before migrations precisely because the
      // migration itself writes a settings row on every fresh database.
      const database = InterleafDatabase.open(store.databasePath);
      const evidence = captureOnboardingLaunchEvidence(database, silentLogger);
      runMigrations(database);
      const afterMigrations = captureOnboardingLaunchEvidence(database, silentLogger);
      database.close();

      expect(evidence.settingsRowPresent).toBe(false);
      expect(afterMigrations.settingsRowPresent).toBe(true);
      expect(deriveOnboardingLaunchState(evidence).verdict).toBe('new-install');
    } finally {
      cleanup(store);
    }
  });

  it('counts a user document as install evidence on its own', () => {
    const store = makeStore();
    try {
      const seed = InterleafDatabase.open(store.databasePath);
      runMigrations(seed);
      seed.raw.prepare(
        `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('doc-1', 'Existing', 'pdf', '/tmp/existing.pdf', 'link', 1, 1, 'hash-1');
      const evidence = captureOnboardingLaunchEvidence(seed, silentLogger);
      seed.close();

      expect(evidence.userRowsPresent).toBe(true);
      // Even with every other signal missing, a user's document is enough.
      const state = deriveOnboardingLaunchState({
        ...evidence,
        priorMigrationHistory: false,
        settingsRowPresent: false,
      });
      expect(state.priorInstallEvidence).toBe(true);
      expect(state.verdict).toBe('upgraded-install');
    } finally {
      cleanup(store);
    }
  });

  it('never classifies an unreadable settings row as a new install', () => {
    const store = makeStore();
    try {
      seedSettingsDocument(store, '{not json');
      const seed = InterleafDatabase.open(store.databasePath);
      const evidence = captureOnboardingLaunchEvidence(seed, silentLogger);
      seed.close();

      expect(evidence.settingsRowPresent).toBe(true);
      expect(evidence.onboardingSectionPresent).toBe(false);
      expect(evidence.status).toBeNull();

      const state = deriveOnboardingLaunchState({ ...evidence, priorMigrationHistory: false });
      expect(state.shouldAutoOpen).toBe(false);
      expect(state.verdict).toBe('upgraded-install');
    } finally {
      cleanup(store);
    }
  });

  it('never auto-opens when the evidence could not be read at all', () => {
    const closed = InterleafDatabase.open(':memory:');
    closed.close();
    const unreadable: OnboardingLaunchEvidence = captureOnboardingLaunchEvidence(closed, silentLogger);

    expect(unreadable.priorMigrationHistory).toBe(true);
    expect(deriveOnboardingLaunchState(unreadable).shouldAutoOpen).toBe(false);
  });
});

describe('onboarding:get-launch-state IPC boundary', () => {
  const indexHtmlPath = path.resolve('out/renderer/index.html');
  const senderRule = createSenderRule({ indexHtmlPath });
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const event = { senderFrame: { url: pathToFileURL(indexHtmlPath).href } } as never;

  it('rejects any payload on a channel declared payload-free', async () => {
    const envelope = await invokeChannel(
      IPC.onboardingGetLaunchState,
      () => ({}) as never,
      { verdict: 'new-install' },
      event,
      { senderRule, log }
    );

    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error.code).toBe('validation');
  });
});

/**
 * Reload after the reader leaves the flow.
 *
 * The launch verdict is latched for the process lifetime on purpose, but a
 * renderer reload asks for it again. Replaying `shouldAutoOpen: true` after the
 * user has already chosen "Finish later" reopens a wizard they dismissed
 * seconds earlier, so the handler is exercised here through the real dispatcher
 * and a real settings repository rather than through the verdict function
 * alone: the persisted decision has to reach it.
 */
describe('onboarding:get-launch-state after a dismissal in the same process', () => {
  const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html' });
  const allowedEvent = { senderFrame: { url: senderRule.allowedProductionFileUrl } };
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

  type Handler = Parameters<IpcMainLike['handle']>[1];

  type Boundary = {
    readonly settings: SettingsRepository;
    readonly invoke: (channel: string, payload?: CloneableValue) => ReturnType<Handler>;
    readonly close: () => void;
  };

  /** A first launch of a genuinely empty store, wired the way main wires it. */
  function firstLaunchBoundary(): Boundary {
    const database = InterleafDatabase.open(':memory:');
    const evidence = captureOnboardingLaunchEvidence(database, silentLogger);
    runMigrations(database);
    const latch = new OnboardingLaunchStateLatch(deriveOnboardingLaunchState(evidence));
    const settings = new SettingsRepository(database, silentLogger);

    const handlers = new Map<string, Handler>();
    registerIpcHandlers(
      { handle: (channel, listener) => {
        handlers.set(channel, listener);
      } },
      makeIpcDeps({
        settings,
        agent: unstubbed<AgentService>('agent', {
          assertSettingsUpdateAllowed: () => undefined,
          applyProfileSettings: () => undefined,
          validateSavedWorkingDirectorySettings: () => Promise.resolve(),
        }),
        senderRule,
        log,
        openExternal: () => Promise.resolve(),
        onboardingLaunchState: () => latch.get(),
      })
    );

    return {
      settings,
      invoke: (channel, payload) => {
        const handler = handlers.get(channel);
        if (handler === undefined) throw new Error(`${channel} handler was not registered`);
        return handler(allowedEvent, payload);
      },
      close: () => { database.close(); },
    };
  }

  /** The state the channel reports right now, unwrapped. */
  async function launchState(boundary: Boundary): Promise<OnboardingLaunchState> {
    const envelope = (await boundary.invoke(IPC.onboardingGetLaunchState)) as
      { ok: boolean; data?: OnboardingLaunchState };
    expect(envelope.ok).toBe(true);
    return envelope.data!;
  }

  it('stops auto-opening once the reader has chosen Finish later', async () => {
    const boundary = firstLaunchBoundary();
    try {
      const atStartup = await launchState(boundary);
      expect(atStartup.verdict).toBe('new-install');
      expect(atStartup.shouldAutoOpen).toBe(true);

      const current = boundary.settings.get();
      await boundary.invoke(IPC.settingsUpdate, {
        ...current,
        onboarding: { ...current.onboarding, status: 'finish-later', lastStageAcknowledged: 'welcome' },
      });

      // The same process, the same latch, a second page load.
      const afterReload = await launchState(boundary);
      expect(afterReload.verdict).toBe('suppressed');
      expect(afterReload.shouldAutoOpen).toBe(false);
      // The install classification itself is untouched: it is still the only
      // record that this was a new install.
      expect(afterReload.priorInstallEvidence).toBe(false);
    } finally {
      boundary.close();
    }
  });

  it('resumes at the stage the reader reached when the flow was interrupted', async () => {
    const boundary = firstLaunchBoundary();
    try {
      const current = boundary.settings.get();
      await boundary.invoke(IPC.settingsUpdate, {
        ...current,
        onboarding: { ...current.onboarding, status: 'in-progress', lastStageAcknowledged: 'discover' },
      });

      const afterReload = await launchState(boundary);
      expect(afterReload.verdict).toBe('resume');
      expect(afterReload.shouldAutoOpen).toBe(true);
      expect(afterReload.resumeStage).not.toBe('welcome');
    } finally {
      boundary.close();
    }
  });
});
