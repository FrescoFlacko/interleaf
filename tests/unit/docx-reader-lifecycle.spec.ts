import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thrown } from '../e2e/owned-run-cleanup';
import type { LaunchRecord } from '../e2e/helpers';

/**
 * The DOCX reader spec's own setup and teardown, driven through its real
 * `beforeEach`/`afterEach` with the launch faked to `launchInterleaf`'s
 * contract (see `launch-interleaf-ownership.spec.ts`): every directory the case
 * owns — its fixture directory, the profile and isolated home its launch
 * created — is removed once its app closed, and only then; an app it could not
 * close keeps everything named; a case that failed keeps its own failure, and a
 * case that passed fails on any cleanup it could not finish.
 */

type Annotation = { readonly type: string; readonly description?: string };
type Hook = () => Promise<void>;
type TestInfoLike = { readonly testId: string; readonly status: string; readonly expectedStatus: string; readonly annotations: Annotation[] };
type FakeChild = { exitCode: number | null; signalCode: string | null };
type Plan = {
  readonly fails?: 'before-start' | 'during-setup' | 'after-return';
  readonly failure?: Thrown;
  /** Close attempts that reject (1-based), and whether the process had exited first. */
  readonly closeRejects?: { readonly attempts: readonly number[]; readonly value: Thrown; readonly exitFirst?: boolean };
};

const harness = vi.hoisted(() => ({
  beforeEach: null as Hook | null,
  info: null as TestInfoLike | null,
  afterEach: null as Hook | null,
  base: '',
  plans: [] as Plan[],
  launches: 0,
  children: [] as FakeChild[],
  removedWhileLive: [] as string[],
  removeFails: null as ((path: string) => boolean) | null,
}));

vi.mock('@playwright/test', () => {
  const test = Object.assign(() => undefined, {
    describe: (_title: string, define: () => void) => { define(); },
    beforeEach: (hook: Hook) => { harness.beforeEach = hook; },
    afterEach: (hook: Hook) => { harness.afterEach = hook; },
    info: () => harness.info,
  });
  return { test, expect: () => undefined };
});

vi.mock('../e2e/listbox', () => ({ chooseListboxValue: () => Promise.resolve() }));

vi.mock('../e2e/helpers', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const exited = (child: FakeChild | null): boolean => child !== null && (child.exitCode !== null || child.signalCode !== null);
  return {
    returnToLibrary: () => Promise.resolve(),
    settleAbandonedLaunches: () => Promise.resolve([]),
    launchInterleaf: async (options: { readonly userDataDir?: string; readonly onLaunch?: (record: LaunchRecord, phase: 'prepared' | 'started') => void } = {}) => {
      await Promise.resolve();
      const index = harness.launches;
      harness.launches += 1;
      const plan = harness.plans[index] ?? {};
      const userDataDir = options.userDataDir ?? real.mkdtempSync(join(harness.base, 'interleaf-e2e-'));
      const home = real.mkdtempSync(join(harness.base, 'interleaf-e2e-home-'));
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
      child = { exitCode: null, signalCode: null };
      harness.children.push(child);
      options.onLaunch?.(record, 'started');
      if (plan.fails === 'during-setup') {
        try { await record.closeProcess(); } catch { /* left to the record's owner */ }
        if (isClosed() || exited(child)) for (const created of record.createdPaths) real.rmSync(created, { recursive: true, force: true });
        throw plan.failure;
      }
      const handle = {
        userDataDir,
        window: {},
        // A raw close: ends the process but knows nothing of the profile or home.
        electronApp: { close: () => record.closeProcess() },
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

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) => {
      if (harness.children.some((child) => child.exitCode === null && child.signalCode === null)) harness.removedWhileLive.push(path);
      if (harness.removeFails?.(path) === true) throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: 'EACCES' });
      real.rmSync(path, options);
    },
  };
});

beforeEach(async () => {
  harness.base = mkdtempSync(join(tmpdir(), 'interleaf-docx-lifecycle-unit-'));
  Object.assign(harness, { plans: [], launches: 0, children: [], removedWhileLive: [], removeFails: null });
  vi.stubEnv('TMPDIR', harness.base);
  if (harness.beforeEach === null) await import('../e2e/docx-reader.spec');
});

afterEach(() => {
  expect(harness.removedWhileLive).toEqual([]);
  vi.unstubAllEnvs();
  rmSync(harness.base, { recursive: true, force: true });
});

function left(): string[] {
  return readdirSync(harness.base).sort();
}

/** Runs the spec's setup, a body with the given outcome, and its teardown. */
async function runCase(status: 'passed' | 'failed'): Promise<{ readonly setup: { threw: boolean; value: Thrown }; readonly teardown: { threw: boolean; value: Thrown }; readonly annotations: Annotation[] }> {
  const annotations: Annotation[] = [];
  const info: TestInfoLike = { testId: 'docx-case', status, expectedStatus: 'passed', annotations };
  harness.info = info;
  const outcome = async (run: () => Promise<void>): Promise<{ threw: boolean; value: Thrown }> => {
    try { await run(); return { threw: false, value: undefined }; } catch (thrown) { return { threw: true, value: thrown }; }
  };
  const setup = await outcome(() => harness.beforeEach!());
  const teardown = await outcome(() => harness.afterEach!());
  return { setup, teardown, annotations };
}

describe('DOCX reader spec setup and teardown', () => {
  it('removes the fixture directory, profile and isolated home after a normal case', async () => {
    const { setup, teardown, annotations } = await runCase('passed');
    expect(setup.threw).toBe(false);
    expect(teardown.threw).toBe(false);
    expect(left()).toEqual([]);
    expect(annotations.map((annotation) => annotation.type)).toContain('owned-cleanup');
  });

  it.each([['an Error', new Error('setup failed')], ['undefined', undefined], ['0', 0]] as const)(
    'closes an app whose launch rejected after it was returned (%s), then removes everything',
    async (_label, value) => {
      harness.plans = [{ fails: 'after-return', failure: value }];
      const { setup, teardown } = await runCase('failed');
      expect(setup.threw && Object.is(setup.value, value)).toBe(true);
      expect(teardown.threw).toBe(false);
      expect(harness.children.every((child) => child.exitCode === 0)).toBe(true);
      expect(left()).toEqual([]);
    },
  );

  it('keeps everything, named, when a launch started no app', async () => {
    harness.plans = [{ fails: 'before-start', failure: new Error('launch failed') }];
    const { teardown, annotations } = await runCase('failed');
    expect(teardown.threw).toBe(false);
    expect(left()).toHaveLength(3);
    expect(annotations.find((annotation) => annotation.type === 'owned-cleanup')?.description).toMatch(/app exit not proven; removed: none; kept: .*interleaf-docx-e2e-.*interleaf-e2e-.*interleaf-e2e-home-/u);
  });

  it('keeps everything and does not replace a failed case with the close failure', async () => {
    harness.plans = [{ closeRejects: { attempts: [1, 2], value: new Error('close rejected') } }];
    const { teardown, annotations } = await runCase('failed');
    expect(teardown.threw).toBe(false);
    expect(left()).toHaveLength(3);
    expect(annotations.find((annotation) => annotation.type === 'owned-cleanup')?.description).toMatch(/^app exit not proven; .*failures: close: Error: close rejected/u);
  });

  it('fails a passing case whose app could not be closed, keeping everything', async () => {
    harness.plans = [{ closeRejects: { attempts: [1, 2], value: 0 } }];
    const { teardown } = await runCase('passed');
    expect(teardown.threw).toBe(true);
    expect(teardown.value).toBeInstanceOf(AggregateError);
    expect(left()).toHaveLength(3);
  });

  it('removes the rest and fails a passing case when one removal fails, naming what was kept', async () => {
    harness.removeFails = (path) => path.includes('interleaf-docx-e2e-');
    const { teardown, annotations } = await runCase('passed');
    expect(teardown.threw).toBe(true);
    expect(left()).toHaveLength(1);
    expect(left()[0]).toMatch(/^interleaf-docx-e2e-/u);
    expect(annotations.find((annotation) => annotation.type === 'owned-cleanup')?.description).toMatch(/kept: .*interleaf-docx-e2e-.*failures: remove .*interleaf-docx-e2e-.*EACCES/u);
  });

  it('removes the paths after an exit it can prove when the close itself rejects', async () => {
    harness.plans = [{ closeRejects: { attempts: [1], value: new Error('close raced the exit'), exitFirst: true } }];
    await runCase('failed');
    expect(left()).toEqual([]);
    expect(existsSync(harness.base)).toBe(true);
  });
});
