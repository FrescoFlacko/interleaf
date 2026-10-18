import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { registerIpcHandlers, type IpcDispatcherDeps, type IpcMainLike } from '@main/ipc/dispatcher';
import { makeIpcDeps } from '../helpers/ipc-deps';
import { unstubbed } from '../helpers/unstubbed';
import type { CloneableValue } from '@shared/models/portable';
import { IPC } from '@shared/constants/ipc';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { createSenderRule } from '@main/ipc/sender-validation';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';

/**
 * The Settings controls that do something outside the settings document: the
 * Privacy confirmation the external-link handler must consult, and the Advanced
 * diagnostic preference that has to reach the main log sink. Both are exercised
 * through the real dispatcher and a real repository.
 */

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const roots: string[] = [];
const senderRule = createSenderRule({
  indexHtmlPath: '/out/renderer/index.html',
  devUrl: 'http://localhost:5173',
});
const allowedEvent = { senderFrame: { url: senderRule.allowedProductionFileUrl } };

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The listener shape the dispatcher hands to `ipcMain.handle`. */
type IpcInvokeListener = Parameters<IpcMainLike['handle']>[1];

type Harness = {
  readonly settings: SettingsRepository;
  readonly invoke: (channel: string, payload: CloneableValue) => ReturnType<IpcInvokeListener>;
  readonly debugLoggingCalls: boolean[];
  readonly automaticCheckCalls: boolean[];
  readonly confirmed: string[];
  readonly opened: string[];
  setConfirmationAnswer: (answer: boolean) => void;
  close: () => void;
};

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-settings-effects-'));
  roots.push(root);
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  const settings = new SettingsRepository(db, logger);
  const agent = createTestAgentService({ database: db,
    repository: new AgentRepository(db),
    registry: new WorkingDirectoryRegistry(),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(null),
    log: logger,
    isPackaged: false,
  });

  const debugLoggingCalls: boolean[] = [];
  const automaticCheckCalls: boolean[] = [];
  const confirmed: string[] = [];
  const opened: string[] = [];
  let confirmationAnswer = true;

  const deps = makeIpcDeps({
    settings,
    agent,
    senderRule,
    log: logger,
    appInfo: () => ({
      name: 'Interleaf',
      tagline: 'Read. Think. Build.',
      version: '0.2.0',
      platform: 'darwin',
      versions: { electron: '43', node: '24', chrome: '130' },
    }),
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    confirmExternalLink: (url) => {
      confirmed.push(url);
      return Promise.resolve(confirmationAnswer);
    },
    applyDiagnosticLogging: (enabled) => {
      debugLoggingCalls.push(enabled);
    },
    updates: unstubbed<IpcDispatcherDeps['updates']>('updates', {
      setAutomaticChecks: (enabled) => { automaticCheckCalls.push(enabled); },
    }),
  });

  const handlers = new Map<string, IpcInvokeListener>();
  registerIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    deps
  );

  return {
    settings,
    debugLoggingCalls,
    automaticCheckCalls,
    confirmed,
    opened,
    setConfirmationAnswer: (answer) => {
      confirmationAnswer = answer;
    },
    invoke: (channel, payload) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`${channel} handler was not registered`);
      return handler(allowedEvent, payload);
    },
    close: () => {
      db.close();
    },
  };
}

function withSections(base: AppSettings, sections: Partial<AppSettings>): AppSettings {
  return { ...base, ...sections };
}

describe('Settings runtime effects at the IPC boundary', () => {
  it('opens links in one click until the reader turns confirmation on', async () => {
    const app = await harness();
    try {
      await expect(app.invoke(IPC.appOpenExternal, { url: 'https://example.org/a' })).resolves.toEqual({
        ok: true,
        data: { opened: true },
      });
      expect(app.confirmed).toEqual([]);
      expect(app.opened).toEqual(['https://example.org/a']);

      const saved = await app.invoke(
        IPC.settingsUpdate,
        withSections(app.settings.get(), { privacy: { confirmExternalLinks: true } })
      );
      expect(saved).toMatchObject({ ok: true, data: { privacy: { confirmExternalLinks: true } } });

      await expect(app.invoke(IPC.appOpenExternal, { url: 'https://example.org/b' })).resolves.toEqual({
        ok: true,
        data: { opened: true },
      });
      expect(app.confirmed).toEqual(['https://example.org/b']);

      app.setConfirmationAnswer(false);
      await expect(app.invoke(IPC.appOpenExternal, { url: 'https://example.org/c' })).resolves.toEqual({
        ok: true,
        data: { opened: false },
      });
      expect(app.opened).toEqual(['https://example.org/a', 'https://example.org/b']);
    } finally {
      app.close();
    }
  });

  it('applies the saved diagnostic-logging preference and preserves other sections', async () => {
    const app = await harness();
    try {
      const resized = await app.invoke(
        IPC.settingsUpdate,
        withSections(app.settings.get(), { layout: { ...DEFAULT_APP_SETTINGS.layout, leftWidth: 288 } })
      );
      expect(resized).toMatchObject({ ok: true });
      expect(app.debugLoggingCalls).toEqual([false]);

      const saved = await app.invoke(
        IPC.settingsUpdate,
        withSections(app.settings.get(), {
          advanced: { debugLogging: true },
          library: { defaultView: 'list', defaultSort: 'title_asc' },
        })
      );
      expect(saved).toMatchObject({
        ok: true,
        data: {
          advanced: { debugLogging: true },
          library: { defaultView: 'list', defaultSort: 'title_asc' },
          layout: { leftWidth: 288 },
        },
      });
      expect(app.debugLoggingCalls).toEqual([false, true]);

      await app.invoke(
        IPC.settingsUpdate,
        withSections(app.settings.get(), { advanced: { debugLogging: false } })
      );
      expect(app.debugLoggingCalls).toEqual([false, true, false]);
    } finally {
      app.close();
    }
  });

  it('applies the saved automatic update-check preference to the running updater', async () => {
    const app = await harness();
    try {
      await app.invoke(IPC.settingsUpdate, withSections(app.settings.get(), { updates: { automaticChecks: false } }));
      expect(app.automaticCheckCalls).toEqual([false]);
      expect(app.settings.get().updates.automaticChecks).toBe(false);
      await app.invoke(IPC.settingsUpdate, withSections(app.settings.get(), { updates: { automaticChecks: true } }));
      expect(app.automaticCheckCalls).toEqual([false, true]);
    } finally {
      app.close();
    }
  });

  it('rejects an unsupported default execution mode without applying anything', async () => {
    const app = await harness();
    try {
      const rejected = await app.invoke(IPC.settingsUpdate, {
        ...app.settings.get(),
        agent: { ...app.settings.get().agent, defaultExecutionMode: 'active-env' },
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(app.debugLoggingCalls).toEqual([]);
      expect(app.automaticCheckCalls).toEqual([]);
      expect(app.settings.get().agent.defaultExecutionMode).toBe('auto-isolated');
    } finally {
      app.close();
    }
  });
});
