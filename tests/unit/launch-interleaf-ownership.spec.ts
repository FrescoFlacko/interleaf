import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thrown } from '../e2e/owned-run-cleanup';
import { abandonedLaunches, launchInterleaf, settleAbandonedLaunches, type LaunchRecord } from '../e2e/helpers';

/**
 * `launchInterleaf` owns what it starts until it hands the app over. Every
 * failure after the app's process exists closes that app, removes only the
 * directories the launch created and only once the close succeeded or the
 * process exited, and rethrows the launch's own failure as the exact value. The
 * caller holds the launch record from the start, so a launch that rejects never
 * takes its app out of reach.
 *
 * The fake Electron application keeps the lifecycle Playwright has: `close()`
 * ends the process, after which `process()` throws.
 */

type FakeChild = { readonly pid: number; exitCode: number | null; signalCode: string | null };
type Step = 'launch' | 'network-guard' | 'first-window' | 'load-state' | 'endpoint-write' | 'on-started';

type FakeState = {
  failAt: Step | null;
  failure: Thrown;
  closeRejects: { readonly value: Thrown; readonly exitFirst: boolean; readonly always?: boolean } | null;
  closeCalls: number;
  events: string[];
  child: FakeChild | null;
  watched: string[];
  /** Playwright's `process()` throws this when the launch first asks for it. */
  processThrows: { readonly value: Thrown } | null;
  /** Reading the child's exit fields throws this. */
  exitFieldsThrow: { readonly value: Thrown } | null;
  /** Whether the started app is still running. */
  live: boolean;
  /** The Playwright test the launch runs in, as `test.info()` reports it. */
  testId: string;
  /** `test.info()` throws this instead of answering. */
  infoThrows: { readonly value: Thrown } | null;
  /** Removing a path this predicate accepts fails with EACCES. */
  rmFails: ((path: string) => boolean) | null;
  /** The owned-run cleanup itself throws this instead of running. */
  cleanupThrows: { readonly value: Thrown } | null;
  /** The running test as the runner's hook sees it, once a test has run. */
  info: RunnerTestInfo | null;
};

type RunnerTestInfo = { readonly testId: string; readonly file?: string; status: string; readonly expectedStatus: string; readonly annotations: { type: string; description?: string }[] };

const fake = vi.hoisted((): FakeState => ({ failAt: null, failure: undefined, closeRejects: null, closeCalls: 0, events: [], child: null, watched: [], processThrows: null, exitFieldsThrow: null, live: false, testId: 'unit-test', infoThrows: null, rmFails: null, cleanupThrows: null, info: null }));
const runnerHooks = vi.hoisted((): (() => Promise<void>)[] => []);
const suiteEndHooks = vi.hoisted((): (() => Promise<void>)[] => []);
const SPEC_FILE = '/repo/tests/e2e/unit-suite.spec.ts';

function failHere(step: Step): void {
  if (fake.failAt === step) throw fake.failure;
}

vi.mock('@playwright/test', () => {
  const page = {
    waitForLoadState: async () => { await Promise.resolve(); failHere('load-state'); },
    evaluate: async () => { await Promise.resolve(); failHere('endpoint-write'); return 'unreached'; },
  };
  return {
    test: {
      info: () => {
        if (fake.infoThrows !== null) throw fake.infoThrows.value;
        return fake.info ?? { testId: fake.testId, file: SPEC_FILE };
      },
      // The hook the helper module registers for every test of a file that loads it.
      afterEach: (hook: () => Promise<void>) => { runnerHooks.push(hook); },
      // The hook the helper module registers to run once a test file's suite ends.
      afterAll: (hook: () => Promise<void>) => { suiteEndHooks.push(hook); },
    },
    expect: () => { throw new Error('setup reached an assertion this test does not drive'); },
    _electron: {
      launch: async () => {
        await Promise.resolve();
        failHere('launch');
        let exitCode: number | null = null;
        const exitField = (value: number | string | null): number | string | null => {
          if (fake.exitFieldsThrow !== null) throw fake.exitFieldsThrow.value;
          return value;
        };
        const child: FakeChild = {
          pid: 4242,
          get exitCode() { return exitField(exitCode) as number | null; },
          set exitCode(value) { exitCode = value; },
          get signalCode() { return exitField(null) as string | null; },
          set signalCode(_value) { /* never signalled here */ },
        };
        fake.child = child;
        fake.live = true;
        let closed = false;
        return {
          process: () => {
            if (fake.processThrows !== null) throw fake.processThrows.value;
            // Playwright's own behaviour once the app has closed.
            if (closed) throw new TypeError("Cannot read properties of undefined (reading '_object')");
            return child;
          },
          firstWindow: async () => { await Promise.resolve(); failHere('first-window'); return page; },
          close: async () => {
            await Promise.resolve();
            fake.closeCalls += 1;
            fake.events.push(`close (paths present: ${fake.watched.map((path) => String(existsSync(path))).join(',')})`);
            const rejection = fake.closeRejects;
            if (rejection !== null && (rejection.always === true || fake.closeCalls === 1)) {
              if (rejection.exitFirst) { exitCode = 0; fake.live = false; }
              throw rejection.value;
            }
            closed = true;
            exitCode = 0;
            fake.live = false;
          },
        };
      },
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) => {
      if (fake.rmFails?.(path) === true) throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: 'EACCES' });
      real.rmSync(path, options);
    },
  };
});

vi.mock('../e2e/owned-run-cleanup', async (importOriginal) => {
  const real = await importOriginal<typeof import('../e2e/owned-run-cleanup')>();
  return {
    ...real,
    closeThenRemoveOwned: (options: Parameters<typeof real.closeThenRemoveOwned>[0]) => {
      if (fake.cleanupThrows !== null) throw fake.cleanupThrows.value;
      return real.closeThenRemoveOwned(options);
    },
  };
});

vi.mock('../e2e/main-network-guard', () => ({
  installMainNetworkGuard: async () => { await Promise.resolve(); failHere('network-guard'); },
}));

vi.mock('../e2e/offline-local-server', () => ({
  denyAllLocalServer: () => Promise.resolve({ endpoint: 'http://127.0.0.1:9', requests: [] }),
}));

let base = '';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'interleaf-launch-ownership-unit-'));
  vi.stubEnv('TMPDIR', base);
  Object.assign(fake, { failAt: null, failure: undefined, closeRejects: null, closeCalls: 0, events: [], child: null, watched: [], processThrows: null, exitFieldsThrow: null, live: false, testId: 'unit-test', infoThrows: null, rmFails: null, cleanupThrows: null, info: null });
});

afterEach(async () => {
  // Every launch a test abandoned is closed and accounted for before the next test.
  Object.assign(fake, { closeRejects: null, rmFails: null, cleanupThrows: null });
  for (const testId of new Set(abandonedLaunches().map((entry) => entry.testId))) await settleAbandonedLaunches({ testId });
  expect(abandonedLaunches()).toEqual([]);
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

async function launchFailingAt(step: Step | null, failure: Thrown, options: { readonly userDataDir?: string; readonly isolatedHome?: string; readonly subscribe?: boolean } = {}): Promise<{
  readonly thrown: Thrown;
  readonly records: readonly { readonly record: LaunchRecord; readonly phase: string }[];
}> {
  Object.assign(fake, { failAt: step, failure });
  const records: { record: LaunchRecord; phase: string }[] = [];
  try {
    const { subscribe = true, ...launchOptions } = options;
    await launchInterleaf({
      ...launchOptions,
      ...(subscribe ? {
        onLaunch: (record: LaunchRecord, phase: 'prepared' | 'started') => {
          records.push({ record, phase });
          if (phase === 'prepared') fake.watched = [...record.createdPaths];
          if (phase === 'started') failHere('on-started');
        },
      } : {}),
    });
  } catch (thrown) {
    return { thrown, records };
  }
  throw new Error('launchInterleaf resolved although a setup step failed');
}

const VALUES: readonly (readonly [string, Thrown])[] = [
  ['an Error', new Error('setup failed')], ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['empty string', ''],
  ['NaN', Number.NaN], ['a Symbol', Symbol('setup failed')], ['a hostile object', { get message(): string { throw new Error('must not be read'); } }],
];

/** The directories a launch with no subscriber created: the only `interleaf-e2e-*` entries under this test's TMPDIR. */
function createdUnder(): string[] {
  return readdirSync(base).filter((name) => name.startsWith('interleaf-e2e-')).map((name) => join(base, name));
}

const POST_SPAWN: readonly Step[] = ['network-guard', 'first-window', 'load-state', 'endpoint-write', 'on-started'];

describe('launchInterleaf ownership across a failed launch', () => {
  it.each(VALUES)('rethrows %s from a launch that fails before the app starts, keeps what it created and leaves nothing to call closed', async (_label, value) => {
    const { thrown, records } = await launchFailingAt('launch', value);
    expect(Object.is(thrown, value)).toBe(true);
    expect(records.map((entry) => entry.phase)).toEqual(['prepared']);
    const record = records[0]!.record;
    expect(record.child).toBeNull();
    expect(record.createdPaths).toHaveLength(2);
    for (const path of record.createdPaths) expect(existsSync(path)).toBe(true);
    await expect(record.closeProcess()).rejects.toThrow(/started no app/u);
    expect(fake.closeCalls).toBe(0);
  });

  it.each(POST_SPAWN)('closes the app it started when %s fails, then removes only what it created, and rethrows the exact failure', async (step) => {
    const failure = new Error(`${step} failed`);
    const { thrown, records } = await launchFailingAt(step, failure);
    expect(thrown).toBe(failure);
    expect(records.map((entry) => entry.phase)).toEqual(['prepared', 'started']);
    const record = records[0]!.record;
    expect(record.child).toBe(fake.child);
    expect(record.child?.exitCode).toBe(0);
    expect(fake.events).toEqual(['close (paths present: true,true)']);
    for (const path of record.createdPaths) expect(existsSync(path)).toBe(false);
  });

  it.each(VALUES)('rethrows %s from a failed setup step unchanged after closing the app', async (_label, value) => {
    const { thrown } = await launchFailingAt('first-window', value);
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.closeCalls).toBe(1);
  });

  it('keeps everything when its close fails and the process is still running, rethrows the setup failure rather than the close failure, and stays retryable', async () => {
    const setup = new Error('first window never came');
    fake.closeRejects = { value: 0, exitFirst: false };
    const { thrown, records } = await launchFailingAt('first-window', setup);
    expect(thrown).toBe(setup);
    const record = records[0]!.record;
    expect(record.child?.exitCode).toBeNull();
    for (const path of record.createdPaths) expect(existsSync(path)).toBe(true);
    await record.closeProcess();
    expect(fake.closeCalls).toBe(2);
    expect(record.child?.exitCode).toBe(0);
  });

  it('removes what it created when its close fails but the process has positively exited', async () => {
    fake.closeRejects = { value: new Error('close raced the exit'), exitFirst: true };
    const { records } = await launchFailingAt('network-guard', new Error('guard failed'));
    for (const path of records[0]!.record.createdPaths) expect(existsSync(path)).toBe(false);
  });

  it("never removes the caller's profile or home, though it still closes the app it started", async () => {
    const userDataDir = join(base, 'caller-profile');
    const isolatedHome = join(base, 'caller-home');
    mkdirSync(userDataDir);
    mkdirSync(isolatedHome);
    const { records } = await launchFailingAt('load-state', new Error('load failed'), { userDataDir, isolatedHome });
    expect(records[0]!.record.createdPaths).toEqual([]);
    expect(records[0]!.record.userDataDir).toBe(userDataDir);
    expect(fake.closeCalls).toBe(1);
    expect(existsSync(userDataDir)).toBe(true);
    expect(existsSync(isolatedHome)).toBe(true);
  });

  it('hands over a record whose process was taken before close, so it reports the exit after Playwright stops answering', async () => {
    const { records } = await launchFailingAt('endpoint-write', new Error('endpoint write failed'));
    const record = records[0]!.record;
    expect(record.child).toEqual({ pid: 4242, exitCode: 0, signalCode: null });
    await expect(record.closeProcess()).resolves.toBeUndefined();
    expect(fake.closeCalls).toBe(1);
  });
});

describe('launchInterleaf ownership when reading the started process fails', () => {
  it.each(VALUES)('closes the app it got back when its process cannot be read (%s), with a subscriber, and rethrows that value', async (_label, value) => {
    fake.processThrows = { value };
    const { thrown, records } = await launchFailingAt(null, undefined);
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.closeCalls).toBe(1);
    expect(fake.live).toBe(false);
    // A successful close is proof enough; there is no child to read.
    expect(records.map((entry) => entry.phase)).toEqual(['prepared']);
    expect(records[0]!.record.child).toBeNull();
    expect(fake.events).toEqual(['close (paths present: true,true)']);
    for (const path of records[0]!.record.createdPaths) expect(existsSync(path)).toBe(false);
  });

  it.each(VALUES)('closes the app it got back when its process cannot be read (%s), without a subscriber, and rethrows that value', async (_label, value) => {
    fake.processThrows = { value };
    const { thrown } = await launchFailingAt(null, undefined, { subscribe: false });
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.closeCalls).toBe(1);
    expect(fake.live).toBe(false);
    expect(createdUnder()).toEqual([]);
  });

  it('keeps what it created when its process cannot be read and the close fails too', async () => {
    const failure = new Error('process unavailable');
    fake.processThrows = { value: failure };
    fake.closeRejects = { value: 0, exitFirst: false };
    const { thrown } = await launchFailingAt(null, undefined, { subscribe: false });
    expect(thrown).toBe(failure);
    expect(fake.live).toBe(true);
    expect(createdUnder()).toHaveLength(2);
  });
});

describe('launchInterleaf ownership when the exit proof itself throws', () => {
  it.each(VALUES)('keeps everything and rethrows the setup failure (%s) when close fails and reading the exit throws', async (_label, value) => {
    fake.closeRejects = { value: 0, exitFirst: false };
    fake.exitFieldsThrow = { value: Symbol('exit proof failed') };
    const { thrown, records } = await launchFailingAt('first-window', value);
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.live).toBe(true);
    for (const path of records[0]!.record.createdPaths) expect(existsSync(path)).toBe(true);
  });

  it.each(VALUES)('removes what it created and rethrows the setup failure (%s) when close succeeds, without reading the exit', async (_label, value) => {
    fake.exitFieldsThrow = { value: Symbol('exit proof failed') };
    const { thrown, records } = await launchFailingAt('load-state', value);
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.live).toBe(false);
    for (const path of records[0]!.record.createdPaths) expect(existsSync(path)).toBe(false);
  });
});

describe('launchInterleaf ownership of a launch that rejects with its app still running', () => {
  const unreadableAndUnclosable = (value: Thrown, always = false): void => {
    fake.processThrows = { value };
    fake.closeRejects = { value: 0, exitFirst: false, always };
  };

  it.each(VALUES)('keeps an app it could not close reachable without a subscriber (%s), and closes it on retry before removing anything', async (_label, value) => {
    unreadableAndUnclosable(value);
    const { thrown } = await launchFailingAt(null, undefined, { subscribe: false });
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.live).toBe(true);
    const [entry] = abandonedLaunches();
    expect(abandonedLaunches()).toHaveLength(1);
    expect(entry).toMatchObject({ testId: 'unit-test' });
    expect([...entry!.retained].sort()).toEqual(createdUnder().sort());
    expect(createdUnder()).toHaveLength(2);
    const [settled] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(fake.closeCalls).toBe(2);
    expect(fake.live).toBe(false);
    expect(settled).toMatchObject({ exit: 'closed', retained: [], failures: [] });
    expect(createdUnder()).toEqual([]);
    expect(abandonedLaunches()).toEqual([]);
    expect(await settleAbandonedLaunches({ testId: 'unit-test' })).toEqual([]);
  });

  it.each(VALUES)('leaves that ownership with a subscriber (%s): nothing is registered, and the record retries the close', async (_label, value) => {
    unreadableAndUnclosable(value);
    const { thrown, records } = await launchFailingAt(null, undefined);
    expect(Object.is(thrown, value)).toBe(true);
    expect(abandonedLaunches()).toEqual([]);
    await records[0]!.record.closeProcess();
    expect(fake.live).toBe(false);
  });

  it('keeps an app that never closes named and reachable, removes nothing, and retries it on the next settlement', async () => {
    unreadableAndUnclosable(new Error('process unavailable'), true);
    await launchFailingAt(null, undefined, { subscribe: false });
    const [first] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(first).toMatchObject({ exit: 'unproven', removed: [] });
    expect(first!.retained).toHaveLength(2);
    expect(createdUnder()).toHaveLength(2);
    expect(abandonedLaunches()).toHaveLength(1);
    await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(fake.closeCalls).toBe(3);
    expect(fake.live).toBe(true);
  });

  it("never removes the caller's profile or home, and retires the launch once its app has closed", async () => {
    const userDataDir = join(base, 'caller-profile');
    const isolatedHome = join(base, 'caller-home');
    mkdirSync(userDataDir);
    mkdirSync(isolatedHome);
    unreadableAndUnclosable(new Error('process unavailable'));
    await launchFailingAt(null, undefined, { subscribe: false, userDataDir, isolatedHome });
    expect(abandonedLaunches()[0]!.retained).toEqual([]);
    const [settled] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(settled).toMatchObject({ exit: 'closed', removed: [], retained: [] });
    expect(existsSync(userDataDir)).toBe(true);
    expect(existsSync(isolatedHome)).toBe(true);
    expect(abandonedLaunches()).toEqual([]);
  });

  it('keeps a partly removed launch with exactly what is left, and finishes it on the next settlement', async () => {
    unreadableAndUnclosable(new Error('process unavailable'));
    await launchFailingAt(null, undefined, { subscribe: false });
    const home = createdUnder().find((path) => path.includes('interleaf-e2e-home-'))!;
    fake.rmFails = (path) => path === home;
    const [partial] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(partial).toMatchObject({ exit: 'closed', retained: [home] });
    expect(partial!.failures.map((failure) => failure.step)).toEqual(['remove']);
    expect(abandonedLaunches()[0]!.retained).toEqual([home]);
    fake.rmFails = null;
    const [rest] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(rest).toMatchObject({ exit: 'closed', removed: [home], retained: [] });
    expect(abandonedLaunches()).toEqual([]);
  });

  it("settles only the launches of the test it is asked about", async () => {
    fake.testId = 'test-a';
    unreadableAndUnclosable(new Error('process unavailable'));
    await launchFailingAt(null, undefined, { subscribe: false });
    expect(await settleAbandonedLaunches({ testId: 'test-b' })).toEqual([]);
    expect(abandonedLaunches()).toHaveLength(1);
    expect(fake.live).toBe(true);
    await settleAbandonedLaunches({ testId: 'test-a' });
    expect(fake.live).toBe(false);
  });

  it.each(VALUES)('keeps the launch failure (%s) when the runner cannot say which test the launch belongs to', async (_label, value) => {
    fake.infoThrows = { value: Symbol('no test info') };
    unreadableAndUnclosable(value);
    const { thrown } = await launchFailingAt(null, undefined, { subscribe: false });
    expect(Object.is(thrown, value)).toBe(true);
    expect(abandonedLaunches()).toMatchObject([{ testId: null }]);
  });

  it.each(VALUES)('keeps the launch failure (%s) and the whole launch reachable when its own cleanup cannot even run', async (_label, value) => {
    fake.cleanupThrows = { value: Symbol('cleanup unavailable') };
    fake.failAt = 'first-window';
    fake.failure = value;
    const { thrown } = await launchFailingAt('first-window', value, { subscribe: false });
    expect(Object.is(thrown, value)).toBe(true);
    expect(fake.live).toBe(true);
    expect(abandonedLaunches()).toHaveLength(1);
    expect([...abandonedLaunches()[0]!.retained].sort()).toEqual(createdUnder().sort());
    fake.cleanupThrows = null;
    const [settled] = await settleAbandonedLaunches({ testId: 'unit-test' });
    expect(settled).toMatchObject({ exit: 'closed', retained: [] });
    expect(createdUnder()).toEqual([]);
  });
});

describe("the runner's settlement of launches a test abandoned", () => {
  /** The test ends: its status is settled, then the runner runs the helper's hook. */
  async function testEnds(status: 'passed' | 'failed', testId = 'unit-test'): Promise<{ readonly threw: boolean; readonly value: Thrown; readonly info: RunnerTestInfo }> {
    const info: RunnerTestInfo = { testId, status, expectedStatus: 'passed', annotations: [] };
    fake.info = info;
    try {
      for (const hook of runnerHooks) await hook();
      return { threw: false, value: undefined, info };
    } catch (thrown) {
      return { threw: true, value: thrown, info };
    } finally {
      fake.info = null;
    }
  }

  const abandonUnclosable = async (value: Thrown, always: boolean): Promise<void> => {
    fake.processThrows = { value };
    fake.closeRejects = { value: 'first close rejected', exitFirst: false, always };
    await launchFailingAt(null, undefined, { subscribe: false });
  };

  it('is registered once by the helper module for the files that load it', () => {
    expect(runnerHooks).toHaveLength(1);
  });

  it.each(VALUES)('retries the close of an app abandoned with %s when its test ends, then removes and retires it', async (_label, value) => {
    await abandonUnclosable(value, false);
    expect(fake.live).toBe(true);
    const { threw, info } = await testEnds('failed');
    expect(threw).toBe(false);
    expect(fake.closeCalls).toBe(2);
    expect(fake.live).toBe(false);
    expect(createdUnder()).toEqual([]);
    expect(abandonedLaunches()).toEqual([]);
    expect(info.annotations).toMatchObject([{ type: 'abandoned-launch', description: expect.stringMatching(/^app closed; removed: .*; kept: none/u) as string }]);
  });

  it('reports an app that still will not close, keeps it named and reachable, and leaves a failed test its own failure', async () => {
    await abandonUnclosable(0, true);
    const { threw, info } = await testEnds('failed');
    expect(threw).toBe(false);
    expect(fake.live).toBe(true);
    expect(createdUnder()).toHaveLength(2);
    expect(abandonedLaunches()).toHaveLength(1);
    expect(info.annotations[0]?.description).toMatch(/^app exit not proven; removed: none; kept: .*interleaf-e2e-.*; failures: close: "first close rejected"/u);
  });

  it('fails a test that passed although a launch it abandoned could not be cleaned up', async () => {
    await abandonUnclosable(new Error('process unavailable'), true);
    const { threw, value } = await testEnds('passed');
    expect(threw).toBe(true);
    expect(value).toBeInstanceOf(AggregateError);
  });

  it('keeps exactly what a partial removal left, and reports it', async () => {
    await abandonUnclosable(new Error('process unavailable'), false);
    const home = createdUnder().find((path) => path.includes('interleaf-e2e-home-'))!;
    fake.rmFails = (path) => path === home;
    const { info } = await testEnds('failed');
    expect(abandonedLaunches()[0]!.retained).toEqual([home]);
    expect(info.annotations[0]?.description).toMatch(/^app closed; removed: .*; kept: .*interleaf-e2e-home-.*; failures: remove/u);
  });

  it('does nothing for a launch whose caller subscribed, and nothing for a test that abandoned nothing', async () => {
    fake.processThrows = { value: new Error('process unavailable') };
    fake.closeRejects = { value: 0, exitFirst: false, always: false };
    const { records } = await launchFailingAt(null, undefined);
    const { info } = await testEnds('failed');
    expect(info.annotations).toEqual([]);
    expect(fake.closeCalls).toBe(1);
    await records[0]!.record.closeProcess();
  });

  it("settles only the launches of the test that is ending, never another test's or an unattributed one", async () => {
    fake.testId = 'other-test';
    await abandonUnclosable(new Error('process unavailable'), false);
    fake.testId = 'unit-test';
    const { info } = await testEnds('failed', 'unit-test');
    expect(info.annotations).toEqual([]);
    expect(fake.live).toBe(true);
    expect(abandonedLaunches()).toMatchObject([{ testId: 'other-test' }]);
    await settleAbandonedLaunches({ testId: 'other-test' });
  });

  it('settles a test once, however many times the hook was registered for it', async () => {
    await abandonUnclosable(new Error('process unavailable'), true);
    const info: RunnerTestInfo = { testId: 'unit-test', status: 'failed', expectedStatus: 'passed', annotations: [] };
    fake.info = info;
    for (const hook of runnerHooks) await hook();
    for (const hook of runnerHooks) await hook();
    fake.info = null;
    expect(fake.closeCalls).toBe(2);
    expect(info.annotations).toHaveLength(1);
  });

  it.each(VALUES)('never replaces a failed test (%s) with a cleanup that cannot even run', async (_label, value) => {
    await abandonUnclosable(value, false);
    fake.cleanupThrows = { value: Symbol('cleanup unavailable') };
    const { threw, info } = await testEnds('failed');
    expect(threw).toBe(false);
    expect(info.annotations[0]?.description).toMatch(/^app exit not proven;/u);
    fake.cleanupThrows = null;
  });
});

describe("the runner's settlement of launches a failed beforeAll abandoned", () => {
  /** The file's suite ends after its beforeAll failed: the runner runs the helper's suite-end hook. */
  async function suiteEnds(status: 'passed' | 'failed', file = SPEC_FILE, info?: RunnerTestInfo): Promise<{ readonly threw: boolean; readonly value: Thrown; readonly info: RunnerTestInfo }> {
    const ending: RunnerTestInfo = info ?? { testId: 'last-test', file, status, expectedStatus: 'passed', annotations: [] };
    fake.info = ending;
    try {
      for (const hook of suiteEndHooks) await hook();
      return { threw: false, value: undefined, info: ending };
    } catch (thrown) {
      return { threw: true, value: thrown, info: ending };
    } finally {
      fake.info = null;
    }
  }

  /** A launch in beforeAll whose process cannot be read and whose first close fails (or every close). */
  const abandonInBeforeAll = async (value: Thrown, always: boolean, file = SPEC_FILE): Promise<void> => {
    fake.info = { testId: 'first-test', file, status: 'passed', expectedStatus: 'passed', annotations: [] };
    fake.processThrows = { value };
    fake.closeRejects = { value: 'first close rejected', exitFirst: false, always };
    await launchFailingAt(null, undefined, { subscribe: false });
    fake.info = null;
  };

  it('is registered once by the helper module for the files that load it', () => {
    expect(suiteEndHooks).toHaveLength(1);
  });

  it.each(VALUES)('closes an app a failed beforeAll abandoned (%s) before the worker moves on, then removes and retires it', async (_label, value) => {
    await abandonInBeforeAll(value, false);
    expect(fake.live).toBe(true);
    const { threw, info } = await suiteEnds('failed');
    expect(threw).toBe(false);
    expect(fake.closeCalls).toBe(2);
    expect(fake.live).toBe(false);
    expect(createdUnder()).toEqual([]);
    expect(abandonedLaunches()).toEqual([]);
    expect(info.annotations).toMatchObject([{ type: 'abandoned-launch', description: expect.stringMatching(/^app closed; removed: .*; kept: none/u) as string }]);
  });

  it('keeps an app that still will not close named and reachable, and records it without replacing the failed beforeAll', async () => {
    await abandonInBeforeAll(new Error('beforeAll primary'), true);
    const { threw, info } = await suiteEnds('failed');
    expect(threw).toBe(false);
    expect(fake.live).toBe(true);
    expect(createdUnder()).toHaveLength(2);
    expect(abandonedLaunches()).toHaveLength(1);
    expect(info.annotations[0]?.description).toMatch(/^app exit not proven; removed: none; kept: .*interleaf-e2e-/u);
  });

  it('fails a suite that passed although a launch it abandoned could not be cleaned up', async () => {
    await abandonInBeforeAll(0, true);
    const { threw, value } = await suiteEnds('passed');
    expect(threw).toBe(true);
    expect(value).toBeInstanceOf(AggregateError);
  });

  it('keeps exactly what a partial removal left', async () => {
    await abandonInBeforeAll(undefined, false);
    const home = createdUnder().find((path) => path.includes('interleaf-e2e-home-'))!;
    fake.rmFails = (path) => path === home;
    await suiteEnds('failed');
    expect(abandonedLaunches()[0]!.retained).toEqual([home]);
  });

  it("settles only the ending file's launches, every one of them, and never another file's", async () => {
    await abandonInBeforeAll(new Error('other file'), false, '/repo/tests/e2e/other.spec.ts');
    const { info } = await suiteEnds('failed');
    expect(info.annotations).toEqual([]);
    expect(fake.live).toBe(true);
    expect(abandonedLaunches()).toHaveLength(1);
    await suiteEnds('failed', '/repo/tests/e2e/other.spec.ts');
    expect(fake.live).toBe(false);
    expect(abandonedLaunches()).toEqual([]);
  });

  it('settles a suite once, however many times the hook was registered for it', async () => {
    await abandonInBeforeAll(new Error('beforeAll primary'), true);
    const info: RunnerTestInfo = { testId: 'last-test', file: SPEC_FILE, status: 'failed', expectedStatus: 'passed', annotations: [] };
    await suiteEnds('failed', SPEC_FILE, info);
    await suiteEnds('failed', SPEC_FILE, info);
    expect(fake.closeCalls).toBe(2);
    expect(info.annotations).toHaveLength(1);
  });

  it('still settles at the end of the suite a launch that test teardown already tried', async () => {
    await abandonInBeforeAll(0, false);
    fake.closeRejects = { value: 'still rejected', exitFirst: false, always: true };
    const info: RunnerTestInfo = { testId: 'first-test', file: SPEC_FILE, status: 'failed', expectedStatus: 'passed', annotations: [] };
    fake.info = info;
    for (const hook of runnerHooks) await hook();
    fake.info = null;
    expect(fake.live).toBe(true);
    fake.closeRejects = null;
    await suiteEnds('failed', SPEC_FILE, info);
    expect(fake.live).toBe(false);
    expect(abandonedLaunches()).toEqual([]);
  });
});
