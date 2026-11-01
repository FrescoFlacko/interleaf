import { writeFileSync } from 'node:fs';
import { test } from '@playwright/test';
import type { AppHandle } from './helpers';

/**
 * Opt-in timing record for the whole-book Agent capture case, for a loaded
 * acceptance run (`INTERLEAF_E2E_AGENT_BOOK_PROFILE=1`); otherwise nothing is
 * installed and every call does nothing. It counts the PDF worker's page and
 * text requests, never their contents, under the test phase the case has just
 * entered, and notes each phase's wall time. The counts say how many requests
 * were sent during a phase, not who sent them: any reader of the book (a
 * capture, rendering, the search index) is counted alike. The test's remaining
 * time budget at each phase comes from the step reporter of the same run.
 *
 * Finishing writes the record to the test's output, then always puts the page
 * hook back (only if it is still the installed one) and releases the page
 * handle, and the case's app is closed after it whatever happened.
 */
type Counts = Record<string, Record<string, number>>;

/** The page-side hook. */
export type WorkerCounts = {
  phase: string;
  readonly counts: Counts;
  /** Puts the original `postMessage` back if this hook is still installed; reports whether it did. */
  readonly restore: () => boolean;
};

/** What the profile needs from the page: the hook, reached across the page boundary. */
export type WorkerCountsHandle = {
  readonly setPhase: (label: string) => Promise<void>;
  readonly counts: () => Promise<Counts>;
  readonly restore: () => Promise<boolean>;
  readonly dispose: () => Promise<void>;
};

type Mark = { readonly phase: string; readonly wall: number };

export type AgentBookProfile = {
  readonly phase: (label: string) => Promise<void>;
  readonly finish: () => Promise<void>;
};

/**
 * Runs in the page: wraps `Worker.prototype.postMessage` to count `GetPage`
 * and `GetTextContent` requests by phase, forwarding every call unchanged.
 */
export function installWorkerCounts(): WorkerCounts {
  const original = Worker.prototype.postMessage;
  const counts: Counts = {};
  const counting = function (this: Worker, message: object | null, second?: Transferable[] | StructuredSerializeOptions): void {
    const action = typeof message === 'object' && message !== null && 'action' in message ? String(message.action) : '';
    if (action === 'GetPage' || action === 'GetTextContent') {
      const bucket = (counts[state.phase] ??= {});
      bucket[action] = (bucket[action] ?? 0) + 1;
    }
    Reflect.apply(original, this, second === undefined ? [message] : [message, second]);
  };
  const state: WorkerCounts = {
    phase: 'armed',
    counts,
    restore: () => {
      if (Worker.prototype.postMessage !== counting) return false;
      Worker.prototype.postMessage = original;
      return true;
    },
  };
  Worker.prototype.postMessage = counting;
  return state;
}

/** The hook installed in the app's window. */
export async function pageWorkerCounts(app: AppHandle): Promise<WorkerCountsHandle> {
  const hook = await app.window.evaluateHandle(installWorkerCounts);
  return {
    setPhase: (label) => hook.evaluate((state, value) => { state.phase = value; }, label),
    counts: () => hook.evaluate((state) => state.counts),
    restore: () => hook.evaluate((state) => state.restore()),
    dispose: () => hook.dispose(),
  };
}

const OFF: AgentBookProfile = { phase: () => Promise.resolve(), finish: () => Promise.resolve() };

type ProfileOptions = {
  readonly enabled?: boolean;
  readonly open: () => Promise<WorkerCountsHandle>;
  readonly outputPath?: (name: string) => string;
  readonly write?: (path: string, text: string) => void;
};

export async function startAgentBookProfile(options: ProfileOptions): Promise<AgentBookProfile> {
  if (!(options.enabled ?? process.env.INTERLEAF_E2E_AGENT_BOOK_PROFILE === '1')) return OFF;
  const outputPath = options.outputPath ?? ((name: string) => test.info().outputPath(name));
  const write = options.write ?? ((path: string, text: string) => { writeFileSync(path, text); });
  const marks: Mark[] = [{ phase: 'armed', wall: Date.now() }];
  const page = await options.open();
  let finished = false;
  return {
    phase: async (label) => {
      marks.push({ phase: label, wall: Date.now() });
      await page.setPhase(label);
    },
    finish: async () => {
      if (finished) return;
      finished = true;
      marks.push({ phase: 'finish', wall: Date.now() });
      let rethrow: (() => never) | null = null;
      try {
        const counts = await page.counts().catch(() => null);
        write(outputPath('agent-book-profile.json'), JSON.stringify({ marks, requestsByPhase: counts }, null, 1));
      } catch (error) {
        rethrow = () => { throw error; };
      }
      try {
        await page.restore();
      } catch (error) {
        rethrow ??= () => { throw error; };
      } finally {
        await page.dispose().catch(() => undefined);
      }
      if (rethrow !== null) rethrow();
    },
  };
}

/**
 * Finishes the profile, then closes the app regardless. The first failure is
 * rethrown exactly as thrown (whatever it is); a close failure that follows a
 * profile failure is reported through `note` rather than replacing it.
 */
export async function finishProfileThenClose(
  profile: AgentBookProfile | null,
  close: () => Promise<void>,
  note: (message: string) => void,
): Promise<void> {
  let rethrow: (() => never) | null = null;
  try {
    await profile?.finish();
  } catch (error) {
    rethrow = () => { throw error; };
  }
  try {
    await close();
  } catch (error) {
    if (rethrow === null) rethrow = () => { throw error; };
    else note(`app close also failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rethrow !== null) rethrow();
}
