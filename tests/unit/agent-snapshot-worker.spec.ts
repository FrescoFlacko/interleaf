import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  MAX_SNAPSHOT_QUEUE,
  SnapshotWorkerPool,
  snapshotRequestDefaults,
  type SnapshotWorkerRequest,
} from '@main/agents/snapshot-worker';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { outcomeOf, rejectionOf } from '../helpers/errors';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/**
 * Item H: snapshot/hash/diff work is offloaded to bounded workers, and the
 * main thread keeps both its authority and its responsiveness.
 *
 * Before this the whole walk and every SHA-256 ran inline on the Electron main
 * thread, bounded only by the 512 MiB / 100 000 entry manifest limits, with no
 * queue, no timeout and no way to cancel.
 */
const ROOTS: string[] = [];
const POOLS: SnapshotWorkerPool[] = [];

/**
 * One pool per test, which is the point of owning it rather than reaching for
 * module state: a drain closes a pool permanently, so a test that drains cannot
 * disable scanning for every test that follows.
 */
function pool(): SnapshotWorkerPool {
  const created = new SnapshotWorkerPool();
  POOLS.push(created);
  return created;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-snapshot-'));
  ROOTS.push(root);
  return root;
}

function request(root: string, overrides: Partial<SnapshotWorkerRequest> = {}): SnapshotWorkerRequest {
  return {
    root,
    generatedNames: ['node_modules', 'dist'],
    stagePrefixes: ['.interleaf-stage-'],
    trackedGeneratedFiles: [],
    trackedGeneratedDirectories: [],
    maxEntries: 100_000,
    maxFileBytes: 64 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
    maxLinkBytes: 4_096,
    ...snapshotRequestDefaults(),
    ...overrides,
  };
}

/** A fresh pool with a fresh authorized root, holding one small file unless told otherwise. */
async function authorizedPool(withFile = true): Promise<{ workers: SnapshotWorkerPool; root: string }> {
  const workers = pool();
  const root = await fixture();
  workers.authorizeRoot(root);
  if (withFile) await writeFile(join(root, 'a.txt'), 'a\n');
  return { workers, root };
}

afterEach(async () => {
  for (const created of POOLS.splice(0, POOLS.length)) await created.drain();
  for (const root of ROOTS.splice(0, ROOTS.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('bounded snapshot worker (item H)', () => {
  it('refuses any root main has not authorized, and stops authorizing it again afterwards', async () => {
    const workers = pool();
    const root = await fixture();
    await writeFile(join(root, 'a.txt'), 'a\n');

    await expect(workers.run(request(root))).rejects.toMatchObject({ code: 'security-violation' });

    workers.authorizeRoot(root);
    const records = await workers.run(request(root));
    expect(records.map((record) => record.path)).toEqual(['a.txt']);
    // A sibling under the same parent is still not an authorized root: the
    // allow-list is exact paths, not a prefix.
    const sibling = join(root, 'nested');
    await mkdir(sibling);
    await expect(workers.run(request(sibling))).rejects.toMatchObject({ code: 'security-violation' });

    workers.revokeRoot(root);
    await expect(workers.run(request(root))).rejects.toMatchObject({ code: 'security-violation' });
  });

  it('walks, hashes and reports link strings without opening a link', async () => {
    const { workers, root } = await authorizedPool(false);
    await mkdir(join(root, 'deep'));
    await writeFile(join(root, 'deep', 'file.txt'), 'hello\n');
    await symlink('file.txt', join(root, 'deep', 'link.txt'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'ignored.js'), 'x');

    const records = [...await workers.run(request(root))].sort((a, b) => a.path.localeCompare(b.path));
    expect(records.map((record) => `${record.kind}:${record.path}`)).toEqual([
      'directory:deep', 'file:deep/file.txt', 'symlink:deep/link.txt',
    ]);
    expect(records.find((record) => record.kind === 'file')?.hash).toMatch(/^[a-f0-9]{64}$/u);
    // The link is carried as its own target string, never as the linked bytes.
    expect(records.find((record) => record.kind === 'symlink')?.linkValue).toBe('file.txt');
    // A symlink record carries no hash field at all: the union makes "link
    // bytes were read" unrepresentable rather than merely null.
    expect(records.find((record) => record.kind === 'symlink')).not.toHaveProperty('hash', expect.any(String));
  });

  it('rejects a malformed result instead of trusting it, and fails closed when the worker dies or exits', async () => {
    const { workers, root } = await authorizedPool(false);
    for (const failure of ['malformed', 'error', 'exit'] as const) {
      await expect(workers.run(request(root), { testWorkerFailure: failure }), failure)
        .rejects.toMatchObject({ code: 'internal' });
    }
  });

  it('bounds the tree it will report at all', async () => {
    const { workers, root } = await authorizedPool(false);
    await writeFile(join(root, 'a.txt'), 'aaaa');
    await writeFile(join(root, 'b.txt'), 'bbbb');
    await expect(workers.run(request(root, { maxTotalBytes: 4 }))).rejects.toMatchObject({ code: 'validation' });

    let deep = root;
    for (let index = 0; index < 5; index += 1) {
      deep = join(deep, `d${String(index)}`);
      await mkdir(deep);
    }
    await expect(workers.run(request(root, { maxDepth: 2 }))).rejects.toMatchObject({ code: 'validation' });
  });

  it('times out, cancels, and discards a result that arrives late', async () => {
    const { workers, root } = await authorizedPool();

    await expect(workers.run(request(root), { testWorkerDelayMs: 5_000, timeoutMs: 40 }))
      .rejects.toThrow(/safe time limit/iu);

    const controller = new AbortController();
    const cancelled = workers.run(request(root), { testWorkerDelayMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/iu);

    // Neither settled call may resolve afterwards: give the slow workers a
    // window in which a late post would land, and require the tree to still
    // be scannable normally.
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 150); });
    await expect(workers.run(request(root))).resolves.toHaveLength(1);
  }, 30_000);

  it('cancels a scan that is still queued as well as one already running', async () => {
    const { workers, root } = await authorizedPool();

    // Two occupy the worker slots; the third can only be waiting for one.
    const holding = new AbortController();
    const running = new AbortController();
    const queued = new AbortController();
    const held = [
      rejectionOf(workers.run(request(root), { testWorkerDelayMs: 10_000, signal: holding.signal })),
      rejectionOf(workers.run(request(root), { testWorkerDelayMs: 10_000, signal: running.signal })),
    ];
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const waiting = workers.run(request(root), { testWorkerDelayMs: 10_000, signal: queued.signal });

    // A queued scan is cancelled where it waits: it never spawns a worker.
    queued.abort();
    await expect(waiting).rejects.toThrow(/cancelled/iu);
    // A running one is cancelled through the same signal, and the slot it held
    // is handed back rather than leaked.
    running.abort();
    expect(await held[1]).toBeInstanceOf(Error);
    holding.abort();
    await Promise.all(held);
    await expect(workers.run(request(root))).resolves.toHaveLength(1);
  }, 30_000);

  it('applies backpressure rather than queueing without bound', async () => {
    const { workers, root } = await authorizedPool();

    const controller = new AbortController();
    const pending: Promise<void>[] = [];
    // Two run, MAX_SNAPSHOT_QUEUE wait, and the next one is refused.
    for (let index = 0; index < MAX_SNAPSHOT_QUEUE + 2; index += 1) {
      pending.push(workers.run(request(root), { testWorkerDelayMs: 3_000, signal: controller.signal }).then(() => undefined, () => undefined));
    }
    await expect(workers.run(request(root), { timeoutMs: 1_000 })).rejects.toThrow(/busy/iu);
    controller.abort();
    await Promise.all(pending);
  }, 30_000);

  it('drains every live worker at shutdown and never admits another scan', async () => {
    const { workers, root } = await authorizedPool();
    const slow = rejectionOf(workers.run(request(root), { testWorkerDelayMs: 10_000 }));
    // Let the worker actually spawn, so the drain has a live thread to kill
    // rather than only a queued request to refuse.
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const afterDrain = workers.drain().then(async () => await rejectionOf(workers.run(request(root))));
    await expect(workers.run(request(root))).rejects.toThrow(/shutting down/iu);
    expect(await slow).toBeInstanceOf(Error);
    // The closure is permanent for this pool: a scan requested after the drain
    // finished is refused, not served by a pool that quietly reopened.
    expect(await afterDrain).toBeInstanceOf(Error);
    expect(await afterDrain).toMatchObject({ message: expect.stringMatching(/shutting down/iu) });
  }, 30_000);

  it('waits for admitted lifecycle work and lets no later scan escape the drain', async () => {
    const { workers, root } = await authorizedPool();

    // An operation admitted *before* shutdown that only reaches its scan
    // afterwards: the pending owner/lifecycle shape. The drain waits for it
    // and lets it finish, which is what keeps a deferred apply able to commit.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let lateScan: Awaited<ReturnType<typeof workers.run>> | Error | null = null;
    const lifecycle = workers.operation(async () => {
      await gate;
      lateScan = await outcomeOf(workers.run(request(root)));
    });

    let drainFinished = false;
    const drained = workers.drain().then(() => { drainFinished = true; });
    // The drain cannot finish while the admitted operation is outstanding.
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 100); });
    expect(drainFinished).toBe(false);
    // Nothing new may be admitted, though: admission closed the moment the
    // drain began, so work that starts afterwards never reaches a dispatch.
    await expect(workers.operation(async () => Promise.resolve('ran'))).rejects.toThrow(/shutting down/iu);
    // Nor may an unadmitted caller dispatch during the grace window.
    await expect(workers.run(request(root))).rejects.toThrow(/shutting down/iu);
    release();
    await lifecycle;
    await drained;
    expect(lateScan).toHaveLength(1);
    // Once the drain has returned, dispatch is closed for good as well: no
    // later scan escapes, by either route.
    await expect(workers.run(request(root))).rejects.toThrow(/shutting down/iu);
    await expect(workers.operation(async () => Promise.resolve('ran'))).rejects.toThrow(/shutting down/iu);
  }, 30_000);

  it('cancels a session review through the real discard path, and refuses scans after the manager drains', async () => {
    const root = await fixture();
    const target = join(root, 'target');
    await mkdir(target);
    for (let index = 0; index < 8; index += 1) await writeFile(join(target, `f${String(index)}.txt`), 'content\n');

    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'app') }));
    const sessionId = 'a0000000-0000-4000-8000-000000000002';
    await manager.prepare({ sessionId, mode: 'active-env', canonicalTargetPath: target });

    // No test-only signal: the session's own cancellation handle is what the
    // production review dispatch carries, and discarding the session is what
    // aborts it. Before this, a discard tore the workspace down while the
    // worker kept hashing it.
    const review = rejectionOf(manager.review(sessionId));
    await manager.discard(sessionId);
    expect(await review).toBeInstanceOf(Error);
    expect(await review).toMatchObject({ message: expect.stringMatching(/cancelled/iu) });

    // The manager's drain closes its pool for this service's lifetime, so a
    // later session cannot prepare a scan on the way out.
    await manager.drainSnapshots();
    await expect(manager.prepare({ sessionId: 'a0000000-0000-4000-8000-000000000003', mode: 'active-env', canonicalTargetPath: target }))
      .rejects.toThrow(/shutting down/iu);
  }, 60_000);

  it('leaves the main event loop idle while a large tree is scanned', async () => {
    const root = await fixture();
    const target = join(root, 'target');
    await mkdir(target);
    // ~96 MiB of incompressible-enough content across 24 files. Hashing this
    // inline saturates the loop it runs on; the point of the measurement is the
    // *ratio*, which does not depend on how fast the machine is.
    const block = Buffer.alloc(4 * 1024 * 1024, 7);
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(target, `blob-${String(index)}.bin`), block);
    }

    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'app') }));
    const sessionId = 'a0000000-0000-4000-8000-000000000001';
    // Event-loop utilization is per-thread: how much of this thread's wall
    // time was spent executing rather than waiting. Measured over `review`,
    // which is the two-snapshot comparison, the inline walk this replaced
    // scored 0.996 (54 ms active, 0 ms idle) and the worker path scores 0.009
    // (1 ms active, 70 ms idle). The threshold is loose enough to survive a
    // slow or loaded machine and still far below a main thread doing the work.
    await manager.prepare({ sessionId, mode: 'active-env', canonicalTargetPath: target });
    const before = performance.eventLoopUtilization();
    const review = await manager.review(sessionId);
    const utilization = performance.eventLoopUtilization(before);

    expect(review.sessionId).toBe(sessionId);
    expect(utilization.utilization).toBeLessThan(0.6);
    await manager.discard(sessionId);
  }, 120_000);
});
