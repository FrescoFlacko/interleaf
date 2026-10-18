import { create } from 'zustand';
import type { ActiveWorkSummary, UpdateState } from '@shared/schemas/updates';
import { bridge } from '../app/api-client';

/**
 * Renderer mirror of main's application-update state.
 *
 * Main owns every decision: whether this install updates itself, where updates
 * come from, which file is downloaded and whether a restart may run. The store
 * only holds the latest validated state main reported (pulled once and then
 * pushed on each change) and the outcome of the user's last request, so the
 * About & Updates panel can explain a refusal without guessing.
 */

export type UpdateAction = 'check' | 'download' | 'restart' | 'release-page';

/** The visible outcome of the last action that did not simply change main's state. */
export type UpdateNotice =
  | { readonly kind: 'blocked'; readonly activeWork: ActiveWorkSummary }
  | { readonly kind: 'failed'; readonly message: string };

type UpdateStore = {
  readonly state: UpdateState | null;
  readonly pending: UpdateAction | null;
  readonly notice: UpdateNotice | null;
  /** Loads main's state and follows its pushes; returns the unsubscribe. */
  readonly connect: () => () => void;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly openReleasePage: () => Promise<void>;
};

const REQUEST_FAILED = 'The request did not complete. Try again.';
const RELEASE_PAGE_FAILED = 'The release page could not be opened.';

export const useUpdateStore = create<UpdateStore>()((set, get) => {
  /** Runs one request at a time; a second click while one is pending does nothing. */
  async function run(action: UpdateAction, request: () => Promise<UpdateNotice | null>): Promise<void> {
    if (get().pending !== null) return;
    set({ pending: action, notice: null });
    let notice: UpdateNotice | null;
    try {
      notice = await request();
    } catch {
      notice = { kind: 'failed', message: REQUEST_FAILED };
    }
    set({ pending: null, notice });
  }

  return {
    state: null,
    pending: null,
    notice: null,
    connect: () => {
      let live = true;
      let pushed = false;
      const unsubscribe = bridge.updates.onState((state) => {
        pushed = true;
        if (live) set({ state });
      });
      bridge.updates.getState().then(
        (state) => {
          // A push that arrived first is newer than this snapshot.
          if (live && !pushed) set({ state });
        },
        () => {
          if (live) set({ notice: { kind: 'failed', message: REQUEST_FAILED } });
        },
      );
      return () => {
        live = false;
        unsubscribe();
      };
    },
    check: () =>
      run('check', async () => {
        set({ state: await bridge.updates.check() });
        return null;
      }),
    download: () =>
      run('download', async () => {
        set({ state: await bridge.updates.download() });
        return null;
      }),
    restart: () =>
      run('restart', async () => {
        const result = await bridge.updates.restart();
        if (result.outcome === 'blocked') return { kind: 'blocked', activeWork: result.activeWork };
        if (result.outcome === 'failed') return { kind: 'failed', message: result.message };
        return null;
      }),
    openReleasePage: () =>
      run('release-page', async () => {
        const { opened } = await bridge.updates.openReleasePage();
        return opened ? null : { kind: 'failed', message: RELEASE_PAGE_FAILED };
      }),
  };
});
