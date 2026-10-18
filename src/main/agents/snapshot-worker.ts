import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isCloneableArray, isCloneableRecord, type CloneableValue } from '@shared/models/portable';

/**
 * Item H: the agent workspace walk, hash and comparison run on bounded worker
 * threads instead of the Electron main thread.
 *
 * Before this, `snapshotDirectory` walked and SHA-256'd an entire selected tree
 * inline — up to the 512 MiB / 100 000 entry manifest bounds — on every
 * prepare, review and apply. Those bounds are the *manifest* limits, not a
 * latency budget: a large repository froze the UI for as long as the hashing
 * took, and nothing could cancel it.
 *
 * Authority is deliberately asymmetric. The worker is a compute offload only:
 * it walks, stats, hashes and reads link strings. Every decision that matters —
 * which roots may be walked, which paths are representable, whether a symlink
 * is allowed, whether the tree fits the manifest bounds — is made in main,
 * before dispatch and again on the result. A worker that returned a smuggled
 * path, an extra entry or an oversized tree changes nothing, because main
 * re-applies the same checks to the raw records. SQLite, credentials and every
 * native handle stay in main; the worker receives paths and nothing else.
 *
 * The worker source is inlined and run with `eval: true`, matching
 * `src/main/workers/hash-file-worker.ts`. That is what keeps this working in a
 * packaged app: there is no separate worker file for asar packing or the
 * bundler's output layout to lose.
 */
/**
 * A discriminated union so the policy pass in main never has to re-ask whether
 * a hash or a link string is present: `isRawRecord` is the single place that
 * decides, and it decides before any record is handed back.
 */
export type RawSnapshotRecord =
  | { readonly kind: 'file'; readonly path: string; readonly mode: number; readonly size: number; readonly hash: string }
  | { readonly kind: 'directory'; readonly path: string; readonly mode: number; readonly size: number }
  | { readonly kind: 'symlink'; readonly path: string; readonly mode: number; readonly size: number; readonly linkValue: string };

export type SnapshotWorkerRequest = {
  /** Canonical, already-authorized by `authorizeSnapshotRoot`. */
  readonly root: string;
  readonly generatedNames: readonly string[];
  readonly stagePrefixes: readonly string[];
  readonly trackedGeneratedFiles: readonly string[];
  readonly trackedGeneratedDirectories: readonly string[];
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly maxLinkBytes: number;
};

export type SnapshotWorkerOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test-only seams; never set from IPC or renderer input. */
  readonly testWorkerFailure?: 'error' | 'exit' | 'malformed' | 'late';
  readonly testWorkerDelayMs?: number;
};

const MAX_SNAPSHOT_WORKERS = 2;
/**
 * A bounded backlog. Sessions, reviews and applies can all ask for a snapshot;
 * they must not be able to retain an unbounded set of pending walks.
 */
export const MAX_SNAPSHOT_QUEUE = 16;
const SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How long a drain lets already-admitted work finish its scan. Shorter than
 * the service's own shutdown timeout, so the pool is never what holds a quit.
 */
const DRAIN_GRACE_MS = 5_000;
const MAX_SNAPSHOT_DEPTH = 64;

type SlotWaiter = { readonly resume: () => void; readonly reject: (error: Error) => void };

function shutdownError(): InterleafError {
  return new InterleafError('internal', 'Agent workspace scanning is shutting down.');
}

function cancelledError(): InterleafError {
  return new InterleafError('internal', 'The workspace scan was cancelled.');
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { open, lstat, readdir, readlink } = require('node:fs/promises');
const { join } = require('node:path');

if (workerData.testWorkerFailure === 'error') throw new Error('test worker failure');
if (workerData.testWorkerFailure === 'exit') process.exit(19);

const request = workerData.request;
const generatedNames = new Set(request.generatedNames);
const trackedFiles = new Set(request.trackedGeneratedFiles);
const trackedDirectories = new Set(request.trackedGeneratedDirectories);

function isGeneratedName(name) {
  return generatedNames.has(name) || request.stagePrefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix));
}

async function hashFile(path, size) {
  // O_NOFOLLOW: the leaf was lstat'd as a regular file a moment ago; if it has
  // become a link since, this open fails rather than reading through it.
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== size) throw new Error('changed');
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== size || after.ino !== opened.ino || after.dev !== opened.dev) throw new Error('changed');
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

(async () => {
  if (typeof workerData.testWorkerDelayMs === 'number' && workerData.testWorkerDelayMs > 0) {
    await new Promise((r) => { setTimeout(r, workerData.testWorkerDelayMs); });
  }
  if (workerData.testWorkerFailure === 'malformed') {
    parentPort.postMessage({ ok: true, records: [{ path: '../escape', kind: 'file', mode: 0o644, size: 1, hash: 'z'.repeat(64), linkValue: null }] });
    return;
  }
  const records = [];
  let total = 0;
  try {
    const visit = async (current, prefix, depth) => {
      if (depth > request.maxDepth) throw new Error('depth');
      const children = await readdir(current, { withFileTypes: true });
      if (children.length > request.maxEntries) throw new Error('entries');
      for (const child of children) {
        const rel = prefix.length === 0 ? child.name : prefix + '/' + child.name;
        if (isGeneratedName(child.name) && !trackedFiles.has(rel) && !trackedDirectories.has(rel)) continue;
        const file = join(current, child.name);
        const details = await lstat(file);
        if (records.length >= request.maxEntries) throw new Error('entries');
        if (details.isSymbolicLink()) {
          const value = await readlink(file);
          if (Buffer.byteLength(value, 'utf8') > request.maxLinkBytes) throw new Error('link');
          records.push({ path: rel, kind: 'symlink', mode: Number(details.mode) & 0o777, size: Buffer.byteLength(value, 'utf8'), hash: null, linkValue: value });
          continue;
        }
        if (details.isDirectory()) {
          records.push({ path: rel, kind: 'directory', mode: details.mode & 0o777, size: 0, hash: null, linkValue: null });
          await visit(file, rel, depth + 1);
        } else if (details.isFile()) {
          if (details.size > request.maxFileBytes) throw new Error('file-bytes');
          total += details.size;
          if (total > request.maxTotalBytes) throw new Error('total-bytes');
          records.push({ path: rel, kind: 'file', mode: details.mode & 0o777, size: details.size, hash: await hashFile(file, details.size), linkValue: null });
        }
      }
    };
    await visit(request.root, '', 0);
    parentPort.postMessage({ ok: true, records });
  } catch (error) {
    parentPort.postMessage({ ok: false, reason: error && typeof error.message === 'string' ? error.message : 'failed' });
  }
})();
`;

function isRawRecord(value: CloneableValue, request: SnapshotWorkerRequest): value is RawSnapshotRecord {
  if (!isCloneableRecord(value)) return false;
  const record = value;
  if (typeof record.path !== 'string' || record.path.length === 0) return false;
  if (record.kind !== 'file' && record.kind !== 'directory' && record.kind !== 'symlink') return false;
  if (typeof record.mode !== 'number' || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777) return false;
  if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > request.maxFileBytes) return false;
  if (record.kind === 'file') {
    if (typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/iu.test(record.hash) || record.linkValue !== null) return false;
  } else if (record.kind === 'symlink') {
    if (record.hash !== null || typeof record.linkValue !== 'string' || Buffer.byteLength(record.linkValue, 'utf8') > request.maxLinkBytes) return false;
  } else if (record.hash !== null || record.linkValue !== null || record.size !== 0) return false;
  return true;
}

/**
 * Every result crossing back into main is re-validated against the same bounds
 * the request carried. A malformed, oversized or duplicated record set is a
 * failure, not a partially trusted answer.
 */
function parseResult(message: CloneableValue, request: SnapshotWorkerRequest): readonly RawSnapshotRecord[] {
  if (!isCloneableRecord(message) || !('ok' in message)) {
    throw new InterleafError('internal', 'The workspace scan returned an unreadable result.');
  }
  if (message.ok !== true) {
    throw new InterleafError('validation', 'The agent workspace could not be scanned within its bounded limits.');
  }
  const records = message.records;
  if (!isCloneableArray(records) || records.length > request.maxEntries) {
    throw new InterleafError('internal', 'The workspace scan returned an unreadable result.');
  }
  const seen = new Set<string>();
  let total = 0;
  for (const record of records) {
    if (!isRawRecord(record, request)) throw new InterleafError('internal', 'The workspace scan returned an unreadable result.');
    if (seen.has(record.path)) throw new InterleafError('internal', 'The workspace scan returned a duplicated entry.');
    seen.add(record.path);
    if (record.kind === 'file') {
      total += record.size;
      if (total > request.maxTotalBytes) throw new InterleafError('validation', 'Agent workspace exceeds bounded manifest limits.');
    }
  }
  return records as readonly RawSnapshotRecord[];
}

export function snapshotRequestDefaults(): Pick<SnapshotWorkerRequest, 'maxDepth'> {
  return { maxDepth: MAX_SNAPSHOT_DEPTH };
}

/**
 * One pool per owner (the agent environment manager owns the only production
 * instance), rather than process-wide module state.
 *
 * The lifecycle this scopes is the point. A shutdown drain has to close
 * admission *permanently* for the service it drains: the previous module-level
 * drain reopened itself at the end, because a process-wide flag left closed
 * would have disabled scanning for a main process that survives. That reopening
 * is exactly the escape — pending owner and lifecycle work that was still in
 * flight when quitting began could reach `run` afterwards and spawn a worker
 * into a torn-down main. Owning the pool makes "closed" mean "this service is
 * finished", and a later service (or a test) simply constructs its own.
 */
export class SnapshotWorkerPool {
  private activeWorkers = 0;
  private readonly waiters: SlotWaiter[] = [];
  private readonly liveWorkers = new Set<Worker>();
  private closed = false;
  private dispatchClosed = false;
  private drainPromise: Promise<void> | null = null;
  /**
   * The only roots a snapshot may ever be taken of. Main registers a canonical
   * path before dispatch; a request for anything else never reaches a worker.
   * This is what keeps "walk this directory" from becoming an arbitrary-read
   * primitive if a caller is ever reached with an attacker-influenced path.
   */
  private readonly authorizedRoots = new Set<string>();
  /**
   * Admitted operations that have not finished. These are the callers that
   * could still ask for a scan, so the drain waits for them instead of only
   * for the workers that happen to be running at the moment it starts.
   */
  private readonly operations = new Set<Promise<void>>();
  /**
   * Marks the async context of an admitted operation. A dispatch is allowed
   * during the drain's grace window only from inside one of these: the drain
   * is already waiting for it, so refusing it would abandon work — a deferred
   * apply, say — that shutdown has promised to let commit.
   */
  private readonly admitted = new AsyncLocalStorage<true>();

  authorizeRoot(canonicalRoot: string): void {
    this.authorizedRoots.add(resolve(canonicalRoot));
  }

  revokeRoot(canonicalRoot: string): void {
    this.authorizedRoots.delete(resolve(canonicalRoot));
  }

  /**
   * Runs one session/preparation/review operation under the drain barrier.
   * Admission is refused once the pool is closed, so work that *begins* after
   * shutdown never reaches a dispatch at all, while work admitted before it
   * is waited for.
   */
  async operation<T>(run: () => Promise<T>): Promise<T> {
    // A nested step of work that is already admitted is not a new admission:
    // refusing it would abandon the very operation the drain is waiting for.
    if (this.closed && this.admitted.getStore() !== true) throw shutdownError();
    const running = this.admitted.run(true, run);
    const tracked = running.then(() => undefined, () => undefined);
    this.operations.add(tracked);
    try {
      return await running;
    } finally {
      this.operations.delete(tracked);
    }
  }

  private assertAuthorizedRoot(root: string): string {
    const canonical = resolve(root);
    for (const authorized of this.authorizedRoots) {
      if (canonical === authorized) return canonical;
    }
    throw new InterleafError('security-violation', 'A workspace snapshot was requested for a directory that is not an authorized agent root.');
  }

  /**
   * A scan is refused once dispatch has closed, and — before that — for any
   * caller that is not inside an operation the drain is already waiting for.
   */
  private assertDispatchOpen(): void {
    if (this.dispatchClosed || (this.closed && this.admitted.getStore() !== true)) throw shutdownError();
  }

  private async acquireWorkerSlot(signal: AbortSignal | undefined): Promise<void> {
    this.assertDispatchOpen();
    if (signal?.aborted === true) throw cancelledError();
    if (this.activeWorkers < MAX_SNAPSHOT_WORKERS) {
      this.activeWorkers += 1;
      return;
    }
    if (this.waiters.length >= MAX_SNAPSHOT_QUEUE) {
      throw new InterleafError('internal', 'Agent workspace scanning is busy; try again shortly.');
    }
    await new Promise<void>((resolvePromise, reject) => {
      const waiters = this.waiters;
      const waiter: SlotWaiter = {
        resume: () => { cleanup(); resolvePromise(); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        cleanup();
        reject(cancelledError());
      };
      function cleanup(): void { signal?.removeEventListener('abort', onAbort); }
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  }

  private releaseWorkerSlot(): void {
    const next = this.waiters.shift();
    // A drain resets the active count under held slots, so this floor keeps a
    // release that arrives afterwards from lending out a slot that never existed.
    if (next) next.resume();
    else this.activeWorkers = Math.max(0, this.activeWorkers - 1);
  }

  /**
   * Shutdown drain, in two phases, and permanent in both.
   *
   * Phase one closes *admission* for good: nothing new may start work that
   * could ask for a scan. Operations already admitted — a deferred apply that
   * graceful shutdown has promised to let commit, an owner handoff mid-flight —
   * are waited for, and may finish the scan they are in the middle of, bounded
   * by {@link DRAIN_GRACE_MS} so a stuck caller cannot hold the quit open.
   *
   * Phase two closes *dispatch* for good and kills what is left: the queue is
   * refused, every live worker is terminated, and the loop repeats until
   * nothing is admitted, queued or running. Because both closures are
   * permanent for this pool, no later scan can appear afterwards — the earlier
   * module-level drain reopened itself at the end, and that reopened window is
   * exactly what a late owner or lifecycle operation could slip through.
   */
  async drain(): Promise<void> {
    this.closed = true;
    this.drainPromise ??= this.performDrain();
    await this.drainPromise;
  }

  private async performDrain(): Promise<void> {
    await this.awaitAdmitted();
    this.dispatchClosed = true;
    for (;;) {
      for (const waiter of this.waiters.splice(0, this.waiters.length)) waiter.reject(shutdownError());
      const live = [...this.liveWorkers];
      this.liveWorkers.clear();
      await Promise.all(live.map(async (worker) => { await worker.terminate().catch(() => undefined); }));
      const pending = [...this.operations];
      if (pending.length === 0 && this.waiters.length === 0 && this.liveWorkers.size === 0) break;
      await Promise.all(pending);
    }
    this.activeWorkers = 0;
  }

  private async awaitAdmitted(): Promise<void> {
    const deadline = Date.now() + DRAIN_GRACE_MS;
    while (this.operations.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const expiry = new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, remaining);
        timer.unref();
      });
      // The tracked promises never reject, so this settles on completion or
      // on the grace window, whichever comes first.
      await Promise.race([Promise.all([...this.operations]), expiry]);
    }
  }

  async run(
    request: SnapshotWorkerRequest,
    options: SnapshotWorkerOptions = {},
  ): Promise<readonly RawSnapshotRecord[]> {
    const root = this.assertAuthorizedRoot(request.root);
    const authorized: SnapshotWorkerRequest = { ...request, root };
    await this.acquireWorkerSlot(options.signal);
    try {
      // Waiting for a slot is itself a window in which the caller can cancel and
      // the app can begin quitting. Re-check both before spawning anything: an
      // `abort` that fired while this call was queued leaves the signal already
      // aborted, and a listener registered afterwards would never hear it.
      this.assertDispatchOpen();
      if (options.signal?.aborted === true) throw cancelledError();
      return await new Promise<readonly RawSnapshotRecord[]>((resolvePromise, reject) => {
        let settled = false;
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: {
            request: authorized,
            testWorkerFailure: options.testWorkerFailure,
            testWorkerDelayMs: options.testWorkerDelayMs,
          },
        });
        this.liveWorkers.add(worker);
        const finish = (): void => {
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', onAbort);
          this.liveWorkers.delete(worker);
          void worker.terminate().catch(() => undefined);
        };
        const timeout = setTimeout(() => {
          if (settled) return;
          finish();
          reject(new InterleafError('internal', 'The agent workspace scan exceeded its safe time limit.'));
        }, options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS);
        timeout.unref();
        const onAbort = (): void => {
          if (settled) return;
          finish();
          reject(cancelledError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.on('message', (message: CloneableValue) => {
          // A result that arrives after a timeout, a cancellation or a drain is
          // discarded: `settled` is the single authority on whether this call
          // still has an answer to give.
          if (settled) return;
          finish();
          try { resolvePromise(parseResult(message, authorized)); } catch (error) { reject(error instanceof Error ? error : new InterleafError('internal', 'The workspace scan returned an unreadable result.')); }
        });
        worker.once('error', () => {
          if (settled) return;
          finish();
          reject(new InterleafError('internal', 'The agent workspace scanning worker failed safely.'));
        });
        worker.once('exit', (code) => {
          if (settled) return;
          finish();
          reject(new InterleafError('internal', `The agent workspace scanning worker exited before completion (${String(code)}).`));
        });
      });
    } finally {
      this.releaseWorkerSlot();
    }
  }
}
