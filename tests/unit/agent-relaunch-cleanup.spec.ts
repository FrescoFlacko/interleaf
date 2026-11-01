import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thrown } from '../e2e/owned-run-cleanup';
import type { LaunchRecord } from '../e2e/helpers';

/**
 * The relaunch handoff spec's own cleanup, driven through its real body with
 * the app launches and the handoff faked: whatever the body threw reaches the
 * runner unchanged, nothing it owns is removed while an app it started may
 * still be running, and the cleanup is always annotated, removal failures and
 * partial removals included.
 *
 * The fake launch keeps `launchInterleaf`'s contract (verified against the
 * real helper in `launch-interleaf-ownership.spec.ts`): it hands over its
 * record as it is prepared and again once its app has started; a setup failure
 * after the start closes that app first; Playwright's `process()` throws once
 * the app has closed. A launch can also reject after the helper returned, as a
 * wrapper around it does in the reviewer's witness, leaving its app running.
 */

type Annotation = { readonly type: string; readonly description?: string };
type Body = (fixtures: Record<string, never>, info: { readonly annotations: Annotation[] }) => Promise<void>;
type FakeChild = { exitCode: number | null; signalCode: string | null };
type Plan = {
  /** Where this launch rejects, if it does. */
  readonly fails?: 'before-start' | 'during-setup' | 'after-return';
  readonly failure?: Thrown;
  /** The close attempts that reject, by attempt number, and whether the process had already exited. */
  readonly closeRejects?: { readonly attempts: readonly number[]; readonly value: Thrown; readonly exitFirst?: boolean };
  /** A start whose process Playwright reported as null. */
  readonly noProcess?: boolean;
};

const harness = vi.hoisted(() => ({
  body: null as Body | null,
  base: '',
  profile: '',
  plans: [] as Plan[],
  launches: 0,
  children: [] as FakeChild[],
  handoffThrows: null as { readonly value: Thrown } | null,
  removeFails: null as ((path: string) => boolean) | null,
  closes: [] as string[],
  removals: [] as string[],
  removedWhileLive: [] as string[],
}));

vi.mock('@playwright/test', () => {
  const test = Object.assign((_title: string, body: Body) => { harness.body = body; }, {
    describe: (_title: string, define: () => void) => { define(); },
    setTimeout: () => undefined,
  });
  return { test };
});

vi.mock('../e2e/helpers', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const exited = (child: FakeChild | null): boolean => child !== null && (child.exitCode !== null || child.signalCode !== null);
  return {
    launchInterleaf: async (options: { readonly userDataDir?: string; readonly onLaunch?: (record: LaunchRecord, phase: 'prepared' | 'started') => void }) => {
      await Promise.resolve();
      const index = harness.launches;
      harness.launches += 1;
      const plan = harness.plans[index] ?? {};
      const userDataDir = options.userDataDir ?? harness.profile;
      const home = join(harness.base, `home-${String(index + 1)}`);
      real.mkdirSync(home);
      let child: FakeChild | null = null;
      let started = false;
      let closed = false;
      let attempts = 0;
      const isClosed = (): boolean => closed;
      const record: LaunchRecord = {
        userDataDir,
        createdPaths: [...(options.userDataDir === undefined ? [userDataDir] : []), home],
        get child() { return child as LaunchRecord['child']; },
        closeProcess: async () => {
          await Promise.resolve();
          if (!started) throw new Error('This launch started no app: there is nothing to close and no process to prove exited.');
          if (closed) return;
          attempts += 1;
          harness.closes.push(`close ${String(index + 1)}`);
          if (plan.closeRejects?.attempts.includes(attempts) === true) {
            if (plan.closeRejects.exitFirst === true && child !== null) child.exitCode = 0;
            throw plan.closeRejects.value;
          }
          closed = true;
          if (child !== null) child.exitCode = 0;
        },
      };
      options.onLaunch?.(record, 'prepared');
      if (plan.fails === 'before-start') throw plan.failure;
      started = true;
      child = plan.noProcess === true ? null : { exitCode: null, signalCode: null };
      if (child !== null) harness.children.push(child);
      options.onLaunch?.(record, 'started');
      if (plan.fails === 'during-setup') {
        try { await record.closeProcess(); } catch { /* left to the record's owner */ }
        if (isClosed() || exited(child)) for (const created of record.createdPaths) real.rmSync(created, { recursive: true, force: true });
        throw plan.failure;
      }
      const handle = {
        userDataDir,
        window: {},
        electronApp: {
          process: () => {
            if (closed) throw new TypeError("Cannot read properties of undefined (reading '_object')");
            return child;
          },
        },
        close: async (closeOptions?: { readonly preserveUserData?: boolean }) => {
          await record.closeProcess();
          if (options.userDataDir === undefined && closeOptions?.preserveUserData !== true) real.rmSync(userDataDir, { recursive: true, force: true });
          real.rmSync(home, { recursive: true, force: true });
        },
      };
      if (plan.fails === 'after-return') throw plan.failure;
      return handle;
    },
  };
});

vi.mock('../e2e/agent-session-handoff', () => ({
  startCompletedAgentSession: () => Promise.resolve({}),
  expectHandoffToNewOwner: async () => {
    await Promise.resolve();
    if (harness.handoffThrows !== null) throw harness.handoffThrows.value;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) => {
      harness.removals.push(path);
      if (harness.children.some((child) => child.exitCode === null && child.signalCode === null)) harness.removedWhileLive.push(path);
      if (harness.removeFails?.(path) === true) throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: 'EACCES' });
      real.rmSync(path, options);
    },
  };
});

beforeEach(async () => {
  harness.base = mkdtempSync(join(tmpdir(), 'interleaf-relaunch-cleanup-unit-'));
  harness.profile = join(harness.base, 'profile');
  mkdirSync(harness.profile);
  Object.assign(harness, { plans: [], launches: 0, children: [], handoffThrows: null, removeFails: null, closes: [], removals: [], removedWhileLive: [] });
  vi.stubEnv('TMPDIR', harness.base);
  if (harness.body === null) await import('../e2e/agent-session-relaunch-handoff.spec');
});

afterEach(() => {
  // Whatever happened, nothing was removed while an app the spec started was still running.
  expect(harness.removedWhileLive).toEqual([]);
  vi.unstubAllEnvs();
  harness.removeFails = null;
  rmSync(harness.base, { recursive: true, force: true });
});

function workingDirectories(): string[] {
  return readdirSync(harness.base).filter((name) => name.startsWith('interleaf-agent-relaunch-'));
}

async function runSpec(): Promise<{ readonly threw: boolean; readonly value: Thrown; readonly description: string }> {
  const body = harness.body;
  if (body === null) throw new Error('The relaunch spec did not register its test.');
  const annotations: Annotation[] = [];
  let outcome: { threw: boolean; value: Thrown };
  try {
    await body({}, { annotations });
    outcome = { threw: false, value: undefined };
  } catch (thrown) {
    outcome = { threw: true, value: thrown };
  }
  expect(annotations).toHaveLength(1);
  expect(annotations[0]?.type).toBe('owned-cleanup');
  return { ...outcome, description: annotations[0]?.description ?? '' };
}

const VALUES: readonly (readonly [string, Thrown])[] = [
  ['an Error', new Error('primary')], ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['empty string', ''], ['NaN', Number.NaN],
];

describe('relaunch handoff spec cleanup', () => {
  it('passes after both launches, removes its profile and working directory after both closes, and annotates it', async () => {
    const outcome = await runSpec();
    expect(outcome.threw).toBe(false);
    expect(harness.closes).toEqual(['close 1', 'close 2']);
    expect(existsSync(harness.profile)).toBe(false);
    expect(workingDirectories()).toEqual([]);
    expect(outcome.description).toMatch(/^app closed; removed: .*profile.*interleaf-agent-relaunch-.*; kept: none$/u);
  });

  it.each(VALUES)('rethrows %s from the body as the exact value and still cleans up', async (_label, value) => {
    harness.handoffThrows = { value };
    const outcome = await runSpec();
    expect(outcome.threw).toBe(true);
    expect(Object.is(outcome.value, value)).toBe(true);
    expect(existsSync(harness.profile)).toBe(false);
  });

  it('keeps the profile and working directory and rethrows the exact primary when the last close rejects without exit proof', async () => {
    const primary = new Error('primary body assertion');
    harness.handoffThrows = { value: primary };
    harness.plans = [{}, { closeRejects: { attempts: [1], value: new Error('close rejected') } }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(primary);
    expect(existsSync(harness.profile)).toBe(true);
    expect(workingDirectories()).toHaveLength(1);
    expect(harness.removals).toEqual([]);
    expect(outcome.description).toMatch(/^app exit not proven; removed: none; kept: .*profile.*interleaf-agent-relaunch-.*; failures: close: Error: close rejected$/u);
  });

  it('treats a start Playwright reported with no process as no exit proof and keeps everything', async () => {
    harness.plans = [{}, { noProcess: true, closeRejects: { attempts: [1], value: new Error('close rejected') } }];
    const outcome = await runSpec();
    expect(outcome.threw).toBe(true);
    expect(existsSync(harness.profile)).toBe(true);
    expect(harness.removals).toEqual([]);
    expect(outcome.description).toMatch(/^app exit not proven;/u);
  });

  it('removes everything when close rejects but the process positively exited, and fails the passing body on that close failure', async () => {
    harness.plans = [{}, { closeRejects: { attempts: [1], value: 0, exitFirst: true } }];
    const outcome = await runSpec();
    expect(outcome.threw).toBe(true);
    expect(Object.is((outcome.value as AggregateError).errors[0], 0)).toBe(true);
    expect(existsSync(harness.profile)).toBe(false);
    expect(workingDirectories()).toEqual([]);
    expect(outcome.description).toMatch(/^app exited after close failed; removed: .*; kept: none; failures: close: 0$/u);
  });

  it('rethrows the exact primary when removing the profile fails, still removes the rest and reports the partial cleanup', async () => {
    const primary = new Error('primary body assertion');
    harness.handoffThrows = { value: primary };
    harness.removeFails = (path) => path === harness.profile;
    const outcome = await runSpec();
    expect(outcome.value).toBe(primary);
    expect(existsSync(harness.profile)).toBe(true);
    expect(workingDirectories()).toEqual([]);
    expect(outcome.description).toMatch(/^app closed; removed: .*interleaf-agent-relaunch-.*; kept: .*profile; failures: remove .*profile: Error: EACCES/u);
  });

  it('fails a passing body when removing the working directory fails, naming what was removed and kept', async () => {
    harness.removeFails = (path) => path.includes('interleaf-agent-relaunch-');
    const outcome = await runSpec();
    expect(outcome.value).toBeInstanceOf(AggregateError);
    expect(existsSync(harness.profile)).toBe(false);
    expect(workingDirectories()).toHaveLength(1);
    expect(outcome.description).toMatch(/kept: .*interleaf-agent-relaunch-.*; failures: remove .*interleaf-agent-relaunch-.*: Error: EACCES/u);
  });
});

describe('relaunch handoff spec cleanup when a launch rejects', () => {
  it.each(VALUES)('rethrows %s from a first launch that fails before its app starts, and keeps everything that launch prepared', async (_label, value) => {
    harness.plans = [{ fails: 'before-start', failure: value }];
    const outcome = await runSpec();
    expect(Object.is(outcome.value, value)).toBe(true);
    expect(harness.removals).toEqual([]);
    expect(existsSync(harness.profile)).toBe(true);
    expect(workingDirectories()).toHaveLength(1);
    expect(outcome.description).toMatch(/^app exit not proven; removed: none; kept: .*profile.*home-1.*interleaf-agent-relaunch-.*; failures: close: Error: This launch started no app/u);
  });

  it('removes what the first launch prepared once that launch closed its own app after a setup failure', async () => {
    const failure = new Error('first window never came');
    harness.plans = [{ fails: 'during-setup', failure }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.closes).toEqual(['close 1']);
    expect(existsSync(harness.profile)).toBe(false);
    expect(workingDirectories()).toEqual([]);
    expect(outcome.description).toMatch(/^app closed; .*kept: none$/u);
  });

  it('closes a first app left running by a rejection after the helper returned, before removing anything', async () => {
    const failure = new Error('late first launch rejection');
    harness.plans = [{ fails: 'after-return', failure }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.closes).toEqual(['close 1']);
    expect(harness.children.every((child) => child.exitCode === 0)).toBe(true);
    expect(existsSync(harness.profile)).toBe(false);
    expect(outcome.description).toMatch(/^app closed; .*kept: none$/u);
  });

  it.each(VALUES)('rethrows %s from a relaunch that fails before its app starts, and keeps the profile, working directory and what it prepared', async (_label, value) => {
    harness.plans = [{}, { fails: 'before-start', failure: value }];
    const outcome = await runSpec();
    expect(Object.is(outcome.value, value)).toBe(true);
    expect(harness.closes).toEqual(['close 1']);
    expect(harness.removals).toEqual([]);
    expect(existsSync(harness.profile)).toBe(true);
    expect(workingDirectories()).toHaveLength(1);
    expect(outcome.description).toMatch(/^app exit not proven; removed: none; kept: .*home-2.*profile.*interleaf-agent-relaunch-/u);
  });

  it('closes the relaunched app left running by a rejection after the helper returned, then removes the profile', async () => {
    const failure = new Error('review forced late second launch rejection');
    harness.plans = [{}, { fails: 'after-return', failure }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.closes).toEqual(['close 1', 'close 2']);
    expect(harness.children.map((child) => child.exitCode)).toEqual([0, 0]);
    expect(existsSync(harness.profile)).toBe(false);
    expect(workingDirectories()).toEqual([]);
    expect(outcome.description).toMatch(/^app closed; .*kept: none$/u);
  });

  it("retries the relaunch's close after its own failed close, and removes the profile only once that retry closed the app", async () => {
    const failure = new Error('relaunch setup failed');
    harness.plans = [{}, { fails: 'during-setup', failure, closeRejects: { attempts: [1], value: new Error('close rejected') } }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.closes).toEqual(['close 1', 'close 2', 'close 2']);
    expect(existsSync(harness.profile)).toBe(false);
    expect(outcome.description).toMatch(/^app closed; .*kept: none$/u);
  });

  it('keeps the profile, working directory and what the relaunch prepared when its app cannot be closed, and rethrows the setup failure', async () => {
    const failure = Symbol('relaunch setup failed');
    harness.plans = [{}, { fails: 'during-setup', failure, closeRejects: { attempts: [1, 2], value: '' } }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.removals).toEqual([]);
    expect(existsSync(harness.profile)).toBe(true);
    expect(existsSync(join(harness.base, 'home-2'))).toBe(true);
    expect(outcome.description).toMatch(/^app exit not proven; removed: none; kept: .*home-2.*profile.*interleaf-agent-relaunch-.*; failures: close: ""$/u);
  });

  it('keeps everything when the first close fails, and rethrows that failure from the body', async () => {
    const failure = new Error('first close rejected');
    harness.plans = [{ closeRejects: { attempts: [1, 2], value: failure } }];
    const outcome = await runSpec();
    expect(outcome.value).toBe(failure);
    expect(harness.launches).toBe(1);
    expect(harness.removals).toEqual([]);
    expect(existsSync(harness.profile)).toBe(true);
    expect(outcome.description).toMatch(/^app exit not proven; removed: none;/u);
  });
});
