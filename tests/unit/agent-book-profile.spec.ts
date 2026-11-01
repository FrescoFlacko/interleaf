import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thrown } from '../e2e/owned-run-cleanup';
import {
  finishProfileThenClose,
  installWorkerCounts,
  startAgentBookProfile,
  type WorkerCounts,
  type WorkerCountsHandle,
} from '../e2e/agent-book-profile';

/**
 * The opt-in whole-book profile (`tests/e2e/agent-book-profile.ts`): its page
 * hook counts PDF worker requests and is put back exactly when the profile
 * finishes, only if it is still the installed hook; finishing always releases
 * the page handle; and the case's app is closed whatever the profile does,
 * with the first failure rethrown as it was thrown.
 */

class FakeWorker {
  readonly sent: (readonly [object | null, (Transferable[] | StructuredSerializeOptions)?])[] = [];
  postMessage(message: object | null, second?: Transferable[] | StructuredSerializeOptions): void {
    this.sent.push(second === undefined ? [message] : [message, second]);
  }
}

const original = FakeWorker.prototype.postMessage;

beforeEach(() => {
  FakeWorker.prototype.postMessage = original;
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  FakeWorker.prototype.postMessage = original;
  vi.unstubAllGlobals();
});

/** A handle over the page hook installed in this process, as the Playwright adapter does in the page. */
function localHandle(overrides: Partial<WorkerCountsHandle> = {}): WorkerCountsHandle & { readonly state: WorkerCounts; disposed: number } {
  const state = installWorkerCounts();
  const handle = {
    state,
    disposed: 0,
    setPhase: (label: string) => { state.phase = label; return Promise.resolve(); },
    counts: () => Promise.resolve(state.counts),
    restore: () => Promise.resolve(state.restore()),
    dispose: () => { handle.disposed += 1; return Promise.resolve(); },
    ...overrides,
  };
  return handle;
}

describe('agent-book profile page hook', () => {
  it('counts page and text requests by phase and forwards every message unchanged', () => {
    const state = installWorkerCounts();
    const worker = new FakeWorker();
    const transfer: Transferable[] = [];
    worker.postMessage({ action: 'GetPage' });
    state.phase = 'capture-1';
    worker.postMessage({ action: 'GetTextContent' }, transfer);
    worker.postMessage({ action: 'Other' }, { transfer });
    worker.postMessage(null);
    expect(state.counts).toEqual({ armed: { GetPage: 1 }, 'capture-1': { GetTextContent: 1 } });
    expect(worker.sent).toEqual([[{ action: 'GetPage' }], [{ action: 'GetTextContent' }, transfer], [{ action: 'Other' }, { transfer }], [null]]);
  });

  it('puts the original back only while it is still the installed hook', () => {
    const state = installWorkerCounts();
    expect(FakeWorker.prototype.postMessage).not.toBe(original);
    expect(state.restore()).toBe(true);
    expect(FakeWorker.prototype.postMessage).toBe(original);

    const again = installWorkerCounts();
    const later = function laterWrapper(this: FakeWorker): void { /* someone else's hook */ };
    FakeWorker.prototype.postMessage = later;
    expect(again.restore()).toBe(false);
    expect(FakeWorker.prototype.postMessage).toBe(later);
  });
});

describe('agent-book profile lifecycle', () => {
  it('when off, touches nothing: no page hook, no output', async () => {
    const open = vi.fn(() => Promise.resolve(localHandle()));
    const write = vi.fn();
    const profile = await startAgentBookProfile({ enabled: false, open, outputPath: (name) => name, write });
    await profile.phase('capture-1');
    await profile.finish();
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(FakeWorker.prototype.postMessage).toBe(original);
  });

  it('finishing writes the record, restores the hook and releases the handle', async () => {
    const handle = localHandle();
    const write = vi.fn();
    const profile = await startAgentBookProfile({ enabled: true, open: () => Promise.resolve(handle), outputPath: (name) => `/out/${name}`, write });
    await profile.phase('capture-2');
    new FakeWorker().postMessage({ action: 'GetTextContent' });
    await profile.finish();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('/out/agent-book-profile.json');
    expect(String(write.mock.calls[0]?.[1])).toContain('"capture-2"');
    expect(FakeWorker.prototype.postMessage).toBe(original);
    expect(handle.disposed).toBe(1);
    await profile.finish();
    expect(write).toHaveBeenCalledTimes(1);
    expect(handle.disposed).toBe(1);
  });

  it('a failed write still restores and releases, and rethrows the write failure itself', async () => {
    const handle = localHandle();
    const failure = new Error('disk full');
    const profile = await startAgentBookProfile({
      enabled: true, open: () => Promise.resolve(handle), outputPath: (name) => name,
      write: () => { throw failure; },
    });
    await expect(profile.finish()).rejects.toBe(failure);
    expect(FakeWorker.prototype.postMessage).toBe(original);
    expect(handle.disposed).toBe(1);
  });

  it('a page that can no longer answer still gets its handle released', async () => {
    const gone = new Error('Target page, context or browser has been closed');
    const handle = localHandle({ counts: () => Promise.reject(gone), restore: () => Promise.reject(gone) });
    const write = vi.fn();
    const profile = await startAgentBookProfile({ enabled: true, open: () => Promise.resolve(handle), outputPath: (name) => name, write });
    await expect(profile.finish()).rejects.toBe(gone);
    expect(String(write.mock.calls[0]?.[1])).toContain('"requestsByPhase": null');
    expect(handle.disposed).toBe(1);
  });
});

describe('closing the app after the profile', () => {
  const thrownValues: readonly (readonly [string, Thrown])[] = [['an Error', new Error('profile failed')], ['0', 0], ['undefined', undefined]];
  for (const [name, thrown] of thrownValues) {
    it(`closes the app when finishing throws ${name}, and rethrows exactly that`, async () => {
      const close = vi.fn(() => Promise.resolve());
      const finish = vi.fn(async (): Promise<void> => {
        await Promise.resolve();
        throw thrown;
      });
      let caught: { readonly value: Thrown } | null = null;
      try {
        await finishProfileThenClose({ phase: () => Promise.resolve(), finish }, close, () => undefined);
      } catch (error) {
        caught = { value: error };
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(caught).not.toBeNull();
      expect(caught?.value).toBe(thrown);
    });
  }

  it('reports a close failure when the profile finished, and keeps the profile failure first when both fail', async () => {
    const closeFailure = new Error('close failed');
    await expect(finishProfileThenClose(null, () => Promise.reject(closeFailure), () => undefined)).rejects.toBe(closeFailure);

    const profileFailure = new Error('profile failed');
    const notes: string[] = [];
    await expect(finishProfileThenClose(
      { phase: () => Promise.resolve(), finish: () => Promise.reject(profileFailure) },
      () => Promise.reject(closeFailure),
      (note) => { notes.push(note); },
    )).rejects.toBe(profileFailure);
    expect(notes).toEqual(['app close also failed: close failed']);
  });

  it('closes the app normally when there is no profile', async () => {
    const close = vi.fn(() => Promise.resolve());
    await finishProfileThenClose(null, close, () => undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
