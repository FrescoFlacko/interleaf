import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { invokeChannel } from '@main/ipc/dispatcher';
import { createSenderRule } from '@main/ipc/sender-validation';
import { buildUpdateHandlers } from '@main/ipc/update-handlers';
import type { Logger } from '@main/logging/logger';
import { createUpdatesBridge } from '../../src/preload/updates-bridge';
import { IPC, IPC_EVENTS } from '@shared/constants/ipc';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { CloneableValue } from '@shared/models/portable';
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { UpdateState } from '@shared/schemas/updates';

/**
 * The update channels carry no request data at all: main rejects any payload
 * and any foreign sender, and preload re-parses every reply and pushed state,
 * so neither side can name a feed, a file or a command for the other.
 */

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html' });
const allowedEvent = { senderFrame: { url: senderRule.allowedProductionFileUrl } } as Pick<IpcMainInvokeEvent, 'senderFrame'>;
const rejectedEvent = { senderFrame: { url: 'https://evil.example.com/' } } as Pick<IpcMainInvokeEvent, 'senderFrame'>;

const STATE: UpdateState = {
  currentVersion: '1.2.2',
  channel: 'stable',
  support: 'self-update',
  automaticChecks: true,
  lastCheckedAt: null,
  phase: { status: 'idle' },
};

function controller() {
  return {
    getState: vi.fn(() => STATE),
    check: vi.fn(() => Promise.resolve(STATE)),
    download: vi.fn(() => STATE),
    restart: vi.fn(() => Promise.resolve({ outcome: 'not-ready' as const })),
    openReleasePage: vi.fn(() => Promise.resolve({ opened: true })),
    setAutomaticChecks: vi.fn(),
  };
}

describe('update IPC handlers', () => {
  it('reaches the controller only for payload-free requests from the app origin', async () => {
    const updates = controller();
    const handlers = buildUpdateHandlers({ updates });
    const deps = { senderRule, log: silentLog };
    await expect(invokeChannel(IPC.updatesCheck, handlers[IPC.updatesCheck], undefined, allowedEvent, deps)).resolves.toEqual({ ok: true, data: STATE });
    const withPayload = await invokeChannel(IPC.updatesRestart, handlers[IPC.updatesRestart], { url: 'https://evil.example.com/x.zip' }, allowedEvent, deps);
    expect(withPayload).toMatchObject({ ok: false, error: { code: 'validation' } });
    const foreign = await invokeChannel(IPC.updatesDownload, handlers[IPC.updatesDownload], undefined, rejectedEvent, deps);
    expect(foreign).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(updates.restart).not.toHaveBeenCalled();
    expect(updates.download).not.toHaveBeenCalled();
  });
});

describe('update settings', () => {
  it('defaults automatic checks on for existing settings files and keeps an opt-out', () => {
    const legacy: Partial<typeof DEFAULT_APP_SETTINGS> = { ...DEFAULT_APP_SETTINGS };
    delete legacy.updates;
    expect(appSettingsSchema.parse(legacy).updates).toEqual({ automaticChecks: true });
    expect(appSettingsSchema.parse({ ...DEFAULT_APP_SETTINGS, updates: { automaticChecks: false } }).updates).toEqual({ automaticChecks: false });
    expect(appSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, updates: { automaticChecks: 'yes' } }).success).toBe(false);
  });
});

type Listener = (event: Electron.IpcRendererEvent, payload: CloneableValue) => void;

describe('updates preload bridge', () => {
  function bridge(reply: CloneableValue) {
    const invoke = vi.fn<(...args: [channel: string, payload?: CloneableValue]) => void>();
    const call = <T,>(...args: [channel: string, payload?: CloneableValue]): Promise<T> => {
      invoke(...args);
      return Promise.resolve(reply as T);
    };
    const listeners = new Map<string, Listener>();
    const ipc = {
      on: (channel: string, listener: Listener) => { listeners.set(channel, listener); },
      removeListener: (channel: string) => { listeners.delete(channel); },
    };
    return { api: createUpdatesBridge(call, ipc), invoke, listeners };
  }

  it('sends no payload and returns only a reply that matches the contract', async () => {
    const { api, invoke } = bridge(STATE);
    await expect(api.check()).resolves.toEqual(STATE);
    expect(invoke).toHaveBeenCalledWith(IPC.updatesCheck);
    const forged = bridge({ ...STATE, phase: { status: 'available', version: '1.2.3', releaseDate: '2026-10-01T12:00:00.000Z', url: 'https://x' } });
    await expect(forged.api.check()).rejects.toThrow('The update response was invalid.');
    await expect(bridge({ outcome: 'restarting', version: '1.2.3-beta' }).api.restart()).rejects.toThrow(InterleafError);
  });

  it('delivers only valid pushed states and unsubscribes', () => {
    const { api, listeners } = bridge(null);
    const received: UpdateState[] = [];
    const unsubscribe = api.onState((state) => { received.push(state); });
    const listener = listeners.get(IPC_EVENTS.updatesState);
    const event = {} as Electron.IpcRendererEvent;
    listener?.(event, STATE);
    listener?.(event, { ...STATE, phase: { status: 'error', code: 'offline', message: 'x'.repeat(1000) } });
    expect(received).toEqual([STATE]);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
