import { describe, expect, it } from 'vitest';
import { closeThenRemoveOwned, runBody, settleOwnedRun, type OwnedCleanup, type Thrown } from '../e2e/owned-run-cleanup';

/**
 * Cleanup for an E2E run that owns its app profile and working directory:
 * nothing it owns is removed until the app has closed or its process has
 * positively exited, every cleanup failure is recorded with the exact paths
 * removed and kept, and whatever the test body threw is rethrown as itself.
 */

type Script = {
  readonly closeThrows?: { readonly value: Thrown };
  readonly exited?: boolean;
  readonly proofThrows?: Error;
  readonly removeThrowsAt?: readonly number[];
};

const OWNED = ['/owned/profile', '/owned/work'] as const;

async function run(script: Script): Promise<{ readonly events: readonly string[]; readonly cleanup: OwnedCleanup }> {
  const events: string[] = [];
  const cleanup = await closeThenRemoveOwned({
    close: async () => {
      await Promise.resolve();
      events.push('close');
      if (script.closeThrows !== undefined) throw script.closeThrows.value;
    },
    hasExited: () => {
      events.push('exit-proof');
      if (script.proofThrows !== undefined) throw script.proofThrows;
      return script.exited ?? false;
    },
    owned: OWNED,
    remove: (path) => {
      events.push(`remove ${path}`);
      if (script.removeThrowsAt?.includes(OWNED.indexOf(path as typeof OWNED[number])) === true) throw new Error(`EACCES ${path}`);
    },
  });
  return { events, cleanup };
}

/** Whatever `settleOwnedRun` throws, captured so it can be compared by identity. */
function settled(body: Awaited<ReturnType<typeof runBody>>, cleanup: OwnedCleanup): { readonly threw: boolean; readonly value: Thrown } {
  try {
    settleOwnedRun(body, cleanup);
    return { threw: false, value: undefined };
  } catch (thrown) {
    return { threw: true, value: thrown };
  }
}

describe('closeThenRemoveOwned', () => {
  it('removes every owned path after a successful close, and only after it', async () => {
    const { events, cleanup } = await run({});
    expect(events).toEqual(['close', 'remove /owned/profile', 'remove /owned/work']);
    expect(cleanup).toEqual({ exit: 'closed', removed: [...OWNED], retained: [], failures: [] });
  });

  it('keeps every owned path when close rejects and the process has not exited', async () => {
    const failure = new Error('close rejected');
    const { events, cleanup } = await run({ closeThrows: { value: failure } });
    expect(events).toEqual(['close', 'exit-proof']);
    expect(cleanup).toEqual({ exit: 'unproven', removed: [], retained: [...OWNED], failures: [{ step: 'close', path: null, thrown: failure }] });
  });

  it('removes the owned paths when close rejects but the process has positively exited, and still records the close failure', async () => {
    const { events, cleanup } = await run({ closeThrows: { value: new Error('close rejected after exit') }, exited: true });
    expect(events).toEqual(['close', 'exit-proof', 'remove /owned/profile', 'remove /owned/work']);
    expect(cleanup.exit).toBe('exited');
    expect(cleanup.removed).toEqual([...OWNED]);
    expect(cleanup.failures.map((failure) => failure.step)).toEqual(['close']);
  });

  it('treats a throwing exit proof as no proof: keeps everything and records both failures', async () => {
    const proof = new Error('process unavailable');
    const { events, cleanup } = await run({ closeThrows: { value: 'close rejected' }, proofThrows: proof });
    expect(events).toEqual(['close', 'exit-proof']);
    expect(cleanup.exit).toBe('unproven');
    expect(cleanup.retained).toEqual([...OWNED]);
    expect(cleanup.failures).toEqual([{ step: 'close', path: null, thrown: 'close rejected' }, { step: 'exit-proof', path: null, thrown: proof }]);
  });

  it('records a removal failure on the first path, still removes the second and reports exactly which was kept', async () => {
    const { events, cleanup } = await run({ removeThrowsAt: [0] });
    expect(events).toEqual(['close', 'remove /owned/profile', 'remove /owned/work']);
    expect(cleanup.removed).toEqual(['/owned/work']);
    expect(cleanup.retained).toEqual(['/owned/profile']);
    expect(cleanup.failures).toHaveLength(1);
    expect(cleanup.failures[0]).toMatchObject({ step: 'remove', path: '/owned/profile' });
  });

  it('reports a partial cleanup when only the second removal fails', async () => {
    const { cleanup } = await run({ removeThrowsAt: [1] });
    expect(cleanup.removed).toEqual(['/owned/profile']);
    expect(cleanup.retained).toEqual(['/owned/work']);
    expect(cleanup.failures[0]).toMatchObject({ step: 'remove', path: '/owned/work' });
  });

  it.each([undefined, null, false, 0, ''])('records a falsy close rejection (%j) as a failure, never as success', async (value) => {
    const { cleanup } = await run({ closeThrows: { value } });
    expect(cleanup.exit).toBe('unproven');
    expect(cleanup.failures).toHaveLength(1);
    expect(Object.is(cleanup.failures[0]?.thrown, value)).toBe(true);
  });
});

describe('runBody', () => {
  it('reports a body that completes as not failed', async () => {
    expect(await runBody(async () => { await Promise.resolve(); })).toEqual({ failed: false });
  });

  it.each([
    ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['empty string', ''], ['NaN', Number.NaN],
  ])('keeps a thrown %s as the exact value, separate from the failed flag', async (_label, value) => {
    const body = await runBody(async () => { await Promise.resolve(); throw value as Thrown; });
    expect(body.failed).toBe(true);
    expect(body.failed && Object.is(body.thrown, value)).toBe(true);
  });
});

describe('settleOwnedRun', () => {
  const clean: OwnedCleanup = { exit: 'closed', removed: ['/owned/profile'], retained: [], failures: [] };
  const leftOpen: OwnedCleanup = { exit: 'unproven', removed: [], retained: ['/owned/profile'], failures: [{ step: 'close', path: null, thrown: new Error('close rejected') }] };
  const partial: OwnedCleanup = { exit: 'closed', removed: ['/owned/profile'], retained: ['/owned/work'], failures: [{ step: 'remove', path: '/owned/work', thrown: new Error('EACCES') }] };

  const hostile = {
    toString: () => { throw new Error('toString must not be called'); },
    get message(): string { throw new Error('message must not be read'); },
  };
  const hostileError = Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('message getter'); } });
  const primaries: readonly (readonly [string, Thrown])[] = [
    ['an Error', new Error('primary body assertion failure')], ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['empty string', ''],
    ['NaN', Number.NaN], ['a symbol', Symbol('primary')], ['a hostile object', hostile], ['an Error with a throwing message', hostileError],
  ];

  it.each(primaries)('rethrows %s from the body as the exact value, even when cleanup also failed', (_label, value) => {
    for (const cleanup of [clean, leftOpen, partial]) {
      const outcome = settled({ failed: true, thrown: value }, cleanup);
      expect(outcome.threw).toBe(true);
      expect(Object.is(outcome.value, value)).toBe(true);
    }
  });

  it('passes a passing body whose cleanup completed', () => {
    expect(settled({ failed: false }, clean)).toEqual({ threw: false, value: undefined });
  });

  it('fails a passing body whose app could not be closed, naming the kept paths and keeping the exact failure', () => {
    const outcome = settled({ failed: false }, leftOpen);
    expect(outcome.threw).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    const aggregate = outcome.value as AggregateError;
    expect(aggregate.message).toMatch(/Owned cleanup did not complete .*app exit not proven.*kept: \/owned\/profile.*close: Error: close rejected/u);
    expect(aggregate.errors[0]).toBe(leftOpen.failures[0]?.thrown);
  });

  it('fails a passing body on a partial removal', () => {
    const outcome = settled({ failed: false }, partial);
    expect(outcome.threw).toBe(true);
    expect((outcome.value as AggregateError).message).toMatch(/removed: \/owned\/profile; kept: \/owned\/work; failures: remove \/owned\/work: Error: EACCES/u);
  });

  it.each([undefined, null, false, 0, ''])('fails a passing body on a falsy cleanup throw (%j), keeping that exact value', (value) => {
    const cleanup: OwnedCleanup = { exit: 'unproven', removed: [], retained: ['/owned/profile'], failures: [{ step: 'close', path: null, thrown: value }] };
    const outcome = settled({ failed: false }, cleanup);
    expect(outcome.threw).toBe(true);
    expect(Object.is((outcome.value as AggregateError).errors[0], value)).toBe(true);
  });

  it('fails a passing body when only the close failed, even though the process exited and everything was removed', () => {
    const cleanup: OwnedCleanup = { exit: 'exited', removed: ['/owned/profile'], retained: [], failures: [{ step: 'close', path: null, thrown: 0 }] };
    expect(settled({ failed: false }, cleanup).threw).toBe(true);
  });

  it('describes every outcome without converting thrown values unsafely', () => {
    expect(settleOwnedRun.describe(clean)).toBe('app closed; removed: /owned/profile; kept: none');
    expect(settleOwnedRun.describe(leftOpen)).toBe('app exit not proven; removed: none; kept: /owned/profile; failures: close: Error: close rejected');
    const odd: OwnedCleanup = {
      exit: 'exited', removed: [], retained: [], failures: [
        { step: 'close', path: null, thrown: hostile }, { step: 'exit-proof', path: null, thrown: hostileError },
        { step: 'remove', path: '/a', thrown: undefined }, { step: 'remove', path: '/b', thrown: '' }, { step: 'remove', path: '/c', thrown: Symbol('s') },
      ],
    };
    expect(settleOwnedRun.describe(odd)).toBe(
      'app exited after close failed; removed: none; kept: none; failures: close: [object Object]; exit-proof: [undescribable thrown value]; remove /a: undefined; remove /b: ""; remove /c: Symbol(s)',
    );
  });
});
