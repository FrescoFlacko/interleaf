import type { AppSettings } from "@shared/schemas/settings";
import type { InterleafAPI } from "@shared/types/api";
import { describeError, reportRejection } from "@shared/models/caught-error";

/**
 * The preload bridge: the only place the renderer reads the `interleafAPI`
 * global. The main window always loads the preload, so the full contract is
 * present whenever the app is mounted; `isBridgeInstalled` is checked once at
 * startup, before anything calls through this object.
 */
export const bridge: InterleafAPI = globalThis.interleafAPI;

/**
 * Whether preload installed the bridge on `scope`. False only when the
 * renderer is served outside Electron (for example `npm run dev:renderer` in a
 * plain browser), where the app cannot run at all.
 */
export function isBridgeInstalled(scope: object = globalThis): boolean {
  return 'interleafAPI' in scope;
}

let settingsLoadWarned = false;
let settingsWriteTail: Promise<AppSettings | undefined> = Promise.resolve(undefined);
let latestQueuedWrite: Promise<AppSettings> | null = null;

/**
 * Loads the persisted settings document through the preload bridge. Returns
 * `null` when the call fails — callers fall back to defaults. Warns at most
 * once.
 */
export async function loadInitialSettings(): Promise<AppSettings | null> {
  try {
    return await bridge.settings.get();
  } catch (error) {
    if (!settingsLoadWarned) {
      settingsLoadWarned = true;
      console.warn(`Interleaf settings load failed: ${describeError(error instanceof Error ? error : null).message}`);
    }
    return null;
  }
}

/**
 * Enqueues a complete-document settings write on the single ordered renderer
 * queue shared by every settings writer (panel resize, panel collapse, and
 * the Settings modal). One queue keeps a write from overtaking an immediately
 * preceding one and avoids last-response-wins races in Electron IPC.
 *
 * `build` is invoked when the write reaches the head of the queue, not when it
 * is enqueued, so a document composed from live renderer state (panel layout,
 * palette) reads that state after every earlier queued write has settled
 * instead of persisting a snapshot that has since moved on. Resolves with
 * main's validated document and rejects with the write's error; either outcome
 * leaves the shared queue usable.
 */
export function enqueueSettingsWrite(build: () => AppSettings): Promise<AppSettings> {
  const write: Promise<AppSettings> = settingsWriteTail.catch(() => undefined).then(() => bridge.settings.update(build()));
  settingsWriteTail = write.catch(() => undefined);
  latestQueuedWrite = write;
  return write;
}

/**
 * Fire-and-forget settings persistence on the shared ordered queue. Never
 * throws; failures are logged.
 */
export function persistSettings(next: AppSettings): void {
  void reportRejection(enqueueSettingsWrite(() => next), (caught) => {
    console.error(`Interleaf settings persist failed: ${describeError(caught).message}`);
  });
}

/**
 * Drains and awaits settlement of queued settings writes until the shared queue
 * is quiescent (no new writes enqueued while awaiting).
 *
 * If an earlier queued write failed but a later write superseded it and
 * succeeded, this resolves with the final state. If the latest observed write
 * failed (unsuperseded), this rejects with that failure while leaving the
 * underlying queue recovered for subsequent writes.
 */
export async function flushPendingSettingsWrites(): Promise<void> {
  while (latestQueuedWrite !== null) {
    const current = latestQueuedWrite;
    try {
      await current;
    } catch (error) {
      if (latestQueuedWrite === current) {
        latestQueuedWrite = null;
        throw error;
      }
      continue;
    }
    if (latestQueuedWrite === current) {
      latestQueuedWrite = null;
      break;
    }
  }
}

/** Resets the settings write queue state for tests. */
export function resetSettingsWriteQueueForTests(): void {
  settingsWriteTail = Promise.resolve(undefined);
  latestQueuedWrite = null;
}
