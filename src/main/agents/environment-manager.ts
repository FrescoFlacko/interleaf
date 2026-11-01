import { errnoCode, toError } from '@shared/models/caught-error';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { type BigIntStats, constants as fsConstants, createReadStream } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { resolveAgentRiskLevel, type ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import type {
  AgentEnvironmentReview,
  AgentEnvironmentReviewResult,
  AgentPatchExportResult,
  EnvironmentFileChange,
  EnvironmentTestResult,
} from '@shared/types/agent-environment';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  AGENT_STAGE_DIRECTORY_PREFIX,
  LEGACY_AGENT_STAGE_DIRECTORY_PREFIX,
  agentSessionBranchName,
  isAgentSessionBranchName,
  isAgentStageDirectoryName,
} from '@shared/legacy/legacy-brand-values';
import {
  SnapshotWorkerPool,
  snapshotRequestDefaults,
  type RawSnapshotRecord,
  type SnapshotWorkerOptions,
  type SnapshotWorkerRequest,
} from './snapshot-worker';
import { applyRefusalReason, assertNoSymlinkChanges, buildChangePlan, MAX_CHANGE_ENTRIES, type SnapshotEntry } from './environment-change-plan';
import { ProtectedRootPolicy } from './protected-roots';
import { assertSafeRelativePath, isSafeRelativePath, toManifestRelativePath } from './relative-path';
import { buildMinimalChildEnvironment, execFileBounded } from './process-runner';
import { isPathWithin, isStrictlyInside, relativePathBetween, relativePathWithin } from '../security/path-guard';
import { type FileIdentity, hasProvableIdentity, parseFileIdentity, proveDirectoryIdentity, sameFileIdentity, statWithIdentity } from '../security/file-identity';
import {
  EMPTY_TRACKED_INDEX,
  parseTrackedIndex,
  readGitTrackedIndex,
  serializeTrackedIndex,
  type GitTrackedIndex,
} from './git-tracked-index';
import {
  copyBackupEntry,
  createBackupBudget,
  preflightRestore,
  removeCreatedEntry,
} from './recovery-backup';
import { loadPreparationOwner, type PreparationOwner } from './preparation-owner';
import {
  isAbandonedPreparationRoot,
  readPreparationJournal,
  removePreparationJournal,
  writePreparationJournal,
  type PreparationJournal,
  type PreparationPhase,
} from './preparation-journal';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, isPortableRecord, parsePortableJson } from '@shared/models/portable';
import { MAX_RETAINED_TEST_RESULTS, MAX_TEST_RESULTS, coalescedTestSummary, readSuppressedTests, readTestResults } from './environment-test-results';
import { MAX_DIFF_BYTES, boundedText, formatMode, simpleUnifiedDiff } from './copy-diff';

const SESSION_ID_RE = /^[a-f0-9-]{36}$/iu;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_PATCH_BYTES = MAX_DIFF_BYTES;
const ABANDONED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
/**
 * Item I: one bounded test-result inventory per session.
 *
 * Test frames come from an untrusted agent process and each accepted result
 * used to become an artifact row plus a full review rebuild, so a flood turned
 * cheap stdout into unbounded main-process work. The inventory is capped here,
 * before any of that: the last slot is reserved for a single deterministic
 * summary that coalesces everything reported after the cap.
 */
const TEST_RESULT_CAPACITY = MAX_TEST_RESULTS - 1;
const PENDING_CLEANUP_FILE = 'pending-git-cleanup.json';
const METADATA_TEMP_FILE = '.environment.json.tmp';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_INDEX_BYTES = 4 * 1024 * 1024;

/** One durable session record: what it is called, what its atomic temp is
 * called, how large it may be, and how it is named in an error. */
type SessionRecordKind = {
  readonly label: string;
  readonly fileName: string;
  readonly temporaryName: string;
  readonly maxBytes: number;
};

const METADATA_RECORD: SessionRecordKind = { label: 'environment metadata', fileName: 'environment.json', temporaryName: METADATA_TEMP_FILE, maxBytes: MAX_METADATA_BYTES };
const MANIFEST_RECORD: SessionRecordKind = { label: 'environment manifest', fileName: 'manifest.json', temporaryName: '.manifest.json.tmp', maxBytes: MAX_MANIFEST_BYTES };
const TRACKED_INDEX_RECORD: SessionRecordKind = { label: 'Git tracked-index record', fileName: 'tracked-index.json', temporaryName: '.tracked-index.json.tmp', maxBytes: MAX_TRACKED_INDEX_BYTES };
const SESSION_RECORDS: readonly SessionRecordKind[] = [METADATA_RECORD, MANIFEST_RECORD, TRACKED_INDEX_RECORD];
const GENERATED_NAMES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out',
  '.next', '.turbo', 'coverage', '.cache', 'tmp', 'temp', '__pycache__',
]);

type Manifest = {
  readonly version: 1;
  readonly rootKind: 'git' | 'copy' | 'active';
  readonly entries: readonly SnapshotEntry[];
  readonly createdAt: string;
};

/**
 * One prepared environment as the manager tracks it internally. Exported as a
 * type only, so a test that reaches a private step can name what it forwards.
 */
export type EnvironmentState = {
  readonly sessionId: string;
  readonly mode: ResolvedAgentExecutionMode;
  readonly targetPath: string;
  /** Durable file identity of `targetPath`, captured at preparation. `null` for
   * environments journaled before it (or with birth time) existed; fails closed. */
  readonly targetIdentity: FileIdentity | null;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly selectedRelativePath: string;
  readonly baselinePath: string;
  readonly sessionRoot: string;
  manifest: Manifest;
  readonly primaryWasDirty: boolean;
  readonly branchName: string | null;
  readonly repositoryRoot: string | null;
  readonly baseHead: string | null;
  readonly containerRuntime: 'docker' | 'podman' | null;
  readonly dangerousProfile: boolean;
  readonly lockKey: string;
  readonly lockScope: string;
  /** Items K/L: the index answer this session's baseline was built against.
   * Frozen at preparation and persisted, so review, Apply and a restart all
   * judge the tree against the same tracked set. */
  trackedIndex: GitTrackedIndex;
  /** True when this environment's metadata claims a frozen `tracked-index.json`
   * exists; a missing record then fails closed instead of reading as legacy. */
  readonly indexFrozen: boolean;
  tests: EnvironmentTestResult[];
  /** Results reported after the cap, represented by one coalesced entry.
   * Cumulative across runs, so a restart never restates a flood as new. */
  suppressedTests: number;
  /** Results admitted by the current run. Reset when a run begins, which is
   * what makes the cap per run rather than per session (item I). */
  runAdmitted: number;
  /** Results this run refused, coalesced into one summary entry. */
  runSuppressed: number;
  /** Where this run's summary lives in `tests`, so a flood of any size
   * rewrites one row in place rather than appending. */
  runSummaryIndex: number | null;
  /** Set by admission, cleared by a flush: refused results never rewrite
   * metadata on their own. */
  testsDirty: boolean;
  released: boolean;
  applied: boolean;
};

type PendingGitCleanup = {
  readonly version: 1;
  readonly sessionId: string;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly branchName: string;
  readonly registered: boolean;
  readonly committed: boolean;
};

type ApplyBackup = { readonly target: string; readonly backup: string | null; readonly existed: boolean };
type ApplyJournal = {
  readonly version: 2;
  readonly state: 'prepared' | 'committed';
  readonly transactionId: string;
  readonly sessionId: string;
  readonly mode: 'isolated-copy' | 'isolated-worktree';
  readonly targetPath: string;
  readonly sessionRoot: string;
  readonly stagePath: string;
  readonly recoveryPath: string;
  readonly createdDirectories: readonly string[];
  readonly backups: readonly { readonly relativePath: string; readonly backupRelativePath: string | null; readonly existed: boolean }[];
  readonly previousManifest: Manifest;
  readonly previousMetadata: PortableRecord;
};

type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;
type EnvironmentAction = 'apply' | 'discard' | 'export-patch' | 'open-folder';

export type ContainerRuntime = 'docker' | 'podman';

/**
 * Explicit admission answer for one agent-reported test result (item I). Only
 * an accepted result may become an artifact or trigger review work.
 */
export type EnvironmentTestRecordOutcome = {
  readonly accepted: boolean;
  /** Results retained for this session, never more than the cap. */
  readonly recorded: number;
  /** Results refused after the cap, all represented by one summary entry. */
  readonly suppressed: number;
};

export type EnvironmentManagerOptions = {
  readonly root: string;
  /**
   * Main-owned protected application-data roots. Defaults to the app-owned
   * environment root alone, so an omitted option is never *less* strict than
   * the containment check this manager already performed.
   */
  readonly protectedRoots?: readonly string[];
  /**
   * The policy object itself, when the owner already has one. Supplying it
   * replaces `protectedRoots`; both describe the same main-owned decision.
   */
  readonly rootPolicy?: ProtectedRootPolicy | undefined;
  readonly now?: () => Date;
  readonly detectRuntime?: () => Promise<ContainerRuntime | null>;
  readonly openFolder: (canonicalPath: string) => Promise<boolean>;
  readonly savePatch: (fileName: string, contents: string) => Promise<boolean>;
  /** Deterministic main-owned Git seam for recovery tests. */
  readonly runGit?: GitRunner;
  /**
   * Item J: the main-owned installation marker that decides which preparation
   * journals are ours. It must sit outside `root`, because everything under
   * `root` is a session subtree an agent runs in. Defaults to a sibling of the
   * environment root.
   */
  readonly preparationOwnerMarker?: string;
  /** Test-only crash seam; production callers leave this unset. */
  readonly applyFaultInjector?: (input: { readonly phase: 'after-target-mutation' | 'after-metadata-temp-write' | 'before-journal-commit' | 'after-journal-commit'; readonly relativePath: string }) => Promise<'process-death' | undefined> | 'process-death' | undefined;
  /**
   * Item J: test-only crash seam for preparation. Fires immediately after the
   * journal recording `phase` is durable, which is exactly the state a real
   * process death at that step would leave behind.
   */
  readonly prepareFaultInjector?: (input: { readonly phase: PreparationFaultPhase }) => Promise<'process-death' | undefined> | 'process-death' | undefined;
};

/**
 * Every injectable preparation crash point: once the journal for a step is
 * durable, and once while its atomic temp file exists but has not been
 * renamed — the torn-write window.
 */
export type PreparationFaultPhase = PreparationPhase | `${PreparationPhase}-temp` | PreparationRecordFaultPhase;

/**
 * The torn-write window of the *records* a preparation step makes durable, as
 * opposed to the journal that reports the step. `tracked-index.json` and
 * `manifest.json` are each written, fsynced and renamed before their journal
 * phase is recorded, so these are the ordering boundaries a crash can expose:
 * a session whose journal says `tracked-index` must never be able to exist
 * without the record that phase claims.
 */
type PreparationRecordFaultPhase = 'tracked-index-record-temp' | 'manifest-record-temp';

export type PreparedEnvironment = {
  readonly workspacePath: string;
  readonly canonicalTargetPath: string;
  readonly review: AgentEnvironmentReview;
};

export type PrepareEnvironmentInput = {
  readonly sessionId: string;
  readonly mode: ResolvedAgentExecutionMode;
  readonly canonicalTargetPath: string;
  readonly expectedIdentity?: FileIdentity;
  readonly dangerousProfile?: boolean;
};

/**
 * Main-owned execution environment lifecycle. This module is deliberately
 * independent of the renderer, adapters, and SQLite so it can be exercised
 * with deterministic temporary directories. A worktree/copy is workspace
 * isolation, not a security containment boundary.
 */
export class AgentEnvironmentManager {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly detectRuntimeFn: () => Promise<ContainerRuntime | null>;
  private readonly openFolderFn: (canonicalPath: string) => Promise<boolean>;
  private readonly savePatchFn: (fileName: string, contents: string) => Promise<boolean>;
  private readonly runGit: GitRunner;
  private readonly protectedRoots: ProtectedRootPolicy;
  private readonly ownerMarkerPath: string;
  private ownerPromise: Promise<PreparationOwner> | null = null;
  private readonly applyFaultInjector: EnvironmentManagerOptions['applyFaultInjector'];
  private readonly prepareFaultInjector: EnvironmentManagerOptions['prepareFaultInjector'];
  private readonly snapshots = new SnapshotWorkerPool();
  /**
   * One cancellation handle per session. Every snapshot this manager dispatches
   * for a session carries it, so discarding or failing a session stops the
   * scans it owns — queued or already running — instead of leaving a worker
   * hashing a workspace nobody is waiting for.
   */
  private readonly cancellations = new Map<string, AbortController>();
  private readonly states = new Map<string, EnvironmentState>();
  private readonly targetLocks = new Map<string, { readonly scope: string }>();
  private readonly actionReservations = new Map<string, EnvironmentAction>();

  constructor(options: EnvironmentManagerOptions) {
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.detectRuntimeFn = options.detectRuntime ?? detectContainerRuntime;
    this.openFolderFn = options.openFolder;
    this.savePatchFn = options.savePatch;
    this.runGit = options.runGit ?? gitOutput;
    this.protectedRoots = options.rootPolicy ?? new ProtectedRootPolicy(options.protectedRoots ?? [this.root]);
    this.ownerMarkerPath = resolve(options.preparationOwnerMarker ?? join(dirname(this.root), `.${basename(this.root)}-preparation-owner.json`));
    if (isPathWithin(this.root, this.ownerMarkerPath)) throw new InterleafError('security-violation', 'The preparation owner marker must live outside the agent environment root.');
    this.applyFaultInjector = options.applyFaultInjector;
    this.prepareFaultInjector = options.prepareFaultInjector;
  }

  /**
   * Item J: exact owned-uncommitted cleanup. A journal this installation wrote,
   * bound to this session root, that never reached its commit point means
   * preparation died halfway through — for every mode, not just Git. Anything
   * else (no journal, a corrupt one, one naming a different session root) is
   * left on disk for explicit repair.
   *
   * Returns true when the caller must stop considering this candidate.
   */
  /**
   * The installation marker, loaded once. Minting it is a durable, main-owned
   * write, so it happens on the first preparation or reconciliation rather than
   * in the constructor, and every later caller shares the same record.
   */
  private sessionSignal(sessionId: string): AbortSignal {
    let controller = this.cancellations.get(sessionId);
    if (controller === undefined) {
      controller = new AbortController();
      this.cancellations.set(sessionId, controller);
    }
    return controller.signal;
  }

  /**
   * Aborts the session's handle in place. The entry is deliberately kept: a
   * scan that is dispatched after the cancellation must see the *aborted*
   * signal, not a freshly minted one. It is dropped only when the session is
   * fully gone, or replaced when the same identity prepares again.
   */
  private cancelSession(sessionId: string): void {
    this.cancellations.get(sessionId)?.abort();
  }

  /**
   * Shutdown drain for the worker pool this manager owns (item H). Admission
   * closes permanently for this manager: anything that was still preparing,
   * reviewing or applying is waited for, and nothing that starts afterwards can
   * dispatch a scan into a main process that is tearing down.
   */
  /**
   * Admits one caller-owned lifecycle operation (apply, discard, export, open)
   * to the same drain barrier the manager's own work uses. The service enters
   * this synchronously with its lifecycle reservation, so an action already in
   * progress when the app quits is waited for rather than cut off, and one
   * that arrives afterwards is refused.
   */
  async admitScanning<T>(operation: () => Promise<T>): Promise<T> {
    return this.snapshots.operation(operation);
  }

  async drainSnapshots(): Promise<void> {
    // Sessions are deliberately *not* cancelled here. The drain's grace window
    // exists so an action that was already admitted — a deferred apply, an
    // owner handoff — can finish the scan it needs; aborting its session
    // signal first would cut off exactly the work shutdown waits for. What
    // stops everything else is the drain itself, which closes admission at
    // once and terminates any surviving worker at the end.
    await this.snapshots.drain();
  }

  private async preparationOwner(): Promise<PreparationOwner> {
    this.ownerPromise ??= loadPreparationOwner(this.ownerMarkerPath);
    try { return await this.ownerPromise; } catch (error) { this.ownerPromise = null; throw error; }
  }

  private async reconcilePreparation(candidate: string): Promise<boolean> {
    const preparation = await readPreparationJournal(candidate, await this.preparationOwner());
    if ((preparation !== null && !preparation.committed) || await isAbandonedPreparationRoot(candidate)) {
      // External Git registration must already have been unwound by the caller.
      // If a pending record survives — or cannot be read, so its registration
      // cannot be ruled out — this is not a clean removal target.
      if ((await readPendingCleanup(candidate)).status !== 'absent') return true;
      await this.removeProvenSession(candidate);
      return true;
    }
    if (preparation !== null) await removePreparationJournal(candidate);
    return false;
  }

  async initialize(activeSessionIds: readonly string[] = []): Promise<void> {
    await this.ensureRoot();
    // Recovery journals are app-owned and are resolved before any session
    // metadata is rehydrated. A malformed journal fails closed rather than
    // allowing normal environment cleanup to reinterpret its paths.
    await this.recoverApplyJournals();
    const active = new Set(activeSessionIds);
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return; }
    for (const entry of entries) {
      if (!SESSION_ID_RE.test(entry) || active.has(entry)) continue;
      const candidate = this.proveSessionPath(entry);
      try {
        const pending = await readPendingCleanup(candidate);
        if (pending.status === 'unreadable') throw new Error('unreadable pending Git cleanup record');
        if (pending.status === 'present' && !pending.record.committed) {
          await cleanupPendingGit(pending.record, this.runGit);
          await unlink(join(candidate, PENDING_CLEANUP_FILE));
          await this.removeProvenSession(candidate);
          this.targetLocks.delete(`pending:${pending.record.sessionId}`);
          continue;
        }
        if (pending.status === 'present' && pending.record.committed) await unlink(join(candidate, PENDING_CLEANUP_FILE));
        if (await this.reconcilePreparation(candidate)) continue;
        const metadata = JSON.parse(await readFile(join(candidate, 'environment.json'), 'utf8')) as PortableValue;
        const state = parseMetadata(metadata);
        if (state.sessionRoot !== candidate || state.sessionId !== entry || (state.branchName !== null && !isAgentSessionBranchName(state.branchName, state.sessionId))) throw new Error('untrusted environment metadata');
        if (state.mode !== 'isolated-worktree' && state.mode !== 'isolated-copy' && state.mode !== 'active-env' && state.mode !== 'native-restricted') throw new Error('unknown environment mode');
        if (await canonicalDirectory(state.targetPath) !== state.targetPath) throw new Error('target identity changed');
        // Canonical path equality alone does not prove the same directory: a
        // replacement, remount, or symlink swap can reproduce the path (and
        // even the contents) with a new file identity. A journal without
        // that identity (pre-identity or corrupt) fails closed here: the
        // directory is left untouched for a later explicit repair, but it is
        // never re-admitted as a privileged resumable environment.
        await assertJournaledTargetIdentity(state);
        const isolated = state.mode === 'isolated-worktree' || state.mode === 'isolated-copy';
        // Direct modes intentionally point at the canonical external target.
        // Only their baseline and session metadata are app-owned deletion
        // targets; never reinterpret the target as a session child.
        if (isolated) {
          if (!isStrictlyInside(candidate, state.workspacePath) || !isStrictlyInside(candidate, state.workspaceRoot) || !isStrictlyInside(candidate, state.baselinePath)) throw new Error('untrusted isolated environment metadata');
        } else {
          if (resolve(state.workspacePath) !== resolve(state.targetPath) || resolve(state.workspaceRoot) !== resolve(state.targetPath) || !isStrictlyInside(candidate, state.baselinePath) || resolve(state.lockScope) !== resolve(state.targetPath)) throw new Error('untrusted direct environment metadata');
        }
          if (state.mode === 'isolated-worktree' && (state.repositoryRoot === null || !await isRegisteredWorktree(state.repositoryRoot, state.workspaceRoot, this.runGit) || resolve(state.workspacePath) !== resolve(safeJoin(state.workspaceRoot, state.selectedRelativePath)))) throw new Error('unknown worktree metadata');
        // Items K/L: rehydrate the frozen index answer before any manifest is
        // interpreted, so a restart never re-reads the primary repository's
        // current index and silently redefines what this baseline meant.
        state.trackedIndex = await readTrackedIndex(candidate, state.indexFrozen);
        const age = this.now().getTime() - (await stat(candidate)).mtimeMs;
        const manifest = await readManifest(candidate);
        // Item F: age alone is not abandonment. A valid environment whose
        // changes have never been applied is the only copy of the agent's
        // work, so it is retained — and rehydrated as reviewable — until the
        // user applies or discards it. Only environments whose work has
        // already been delivered, and entries with no readable manifest to
        // review, remain subject to the age bound below.
        const preparedUnapplied = manifest !== null && !state.applied;
        if (age < ABANDONED_MAX_AGE_MS || preparedUnapplied) {
          if (manifest !== null) {
            state.manifest = manifest;
            state.tests = [...readTestResults(metadata)];
            // Carried across restarts so a session that already flooded keeps
            // one truthful coalesced count instead of restarting it at one.
            state.suppressedTests = readSuppressedTests(metadata);
            if ([...this.targetLocks.values()].some((lock) => pathsOverlap(lock.scope, state.lockScope))) continue;
            this.states.set(state.sessionId, state);
            this.targetLocks.set(state.lockKey, { scope: state.lockScope });
          }
          continue;
        }
        if (state.mode === 'isolated-worktree' && state.repositoryRoot !== null) {
            if (!await isRegisteredWorktree(state.repositoryRoot, state.workspaceRoot, this.runGit) || resolve(state.workspacePath) !== resolve(safeJoin(state.workspaceRoot, state.selectedRelativePath))) throw new Error('unknown worktree metadata');
            await this.runGit(state.repositoryRoot, ['worktree', 'remove', '--force', state.workspaceRoot]);
            if (state.branchName !== null && await gitBranchExists(state.repositoryRoot, state.branchName, this.runGit)) await this.runGit(state.repositoryRoot, ['branch', '-D', state.branchName]);
        }
        await this.removeProvenSession(candidate);
      } catch {
        // Unknown/corrupt entries are never recursively deleted. They remain
        // for a later explicit repair instead of turning a broad path into a
        // destructive cleanup target.
        try {
          // An unreadable record cannot name a repository, so no lock can be
          // taken for it; the session root is retained untouched either way.
          const pending = await readPendingCleanup(candidate);
          if (pending.status === 'present' && !pending.record.committed && ![...this.targetLocks.values()].some((lock) => pathsOverlap(lock.scope, pending.record.repositoryRoot))) {
            this.targetLocks.set(`pending:${pending.record.sessionId}`, { scope: pending.record.repositoryRoot });
          }
        } catch { /* metadata remains untouched */ }
      }
    }
  }

  async prepare(input: PrepareEnvironmentInput): Promise<PreparedEnvironment> {
    return this.snapshots.operation(() => this.prepareAdmitted(input));
  }

  private async prepareAdmitted(input: PrepareEnvironmentInput): Promise<PreparedEnvironment> {
    if (!SESSION_ID_RE.test(input.sessionId)) throw new InterleafError('validation', 'Invalid agent session identity.');
    // A new preparation for this identity gets a live handle, never the
    // already-aborted one a previous attempt left behind.
    this.cancellations.delete(input.sessionId);
    const targetPath = await canonicalDirectory(input.canonicalTargetPath);
    // Ordering is load-bearing: the protected-root matrix is rejected before
    // the target lock is taken and before the session root is created, so a
    // rejected start leaves no lock, directory, snapshot, copy, or baseline
    // behind. This applies equally to isolated and direct (active-env /
    // native-restricted) preparation.
    await this.protectedRoots.assertSelectable(targetPath);
    if (input.expectedIdentity !== undefined && !sameFileIdentity(input.expectedIdentity, (await statWithIdentity(targetPath)).identity)) {
      throw new InterleafError('mode-resolution-failed', 'The selected target directory changed on disk and must be selected again.');
    }
    let lockScope = targetPath;
    let repositoryRootForLock: string | null = null;
    if (input.mode === 'isolated-worktree') {
      if (!(await isGitRepository(targetPath, this.runGit))) throw new InterleafError('mode-resolution-failed', 'Cannot prepare Isolated Worktree because the target is not a Git repository.');
      repositoryRootForLock = await this.runGit(targetPath, ['rev-parse', '--show-toplevel']);
      lockScope = repositoryRootForLock;
    }
    if ([...this.targetLocks.values()].some((lock) => pathsOverlap(lock.scope, lockScope))) {
      throw new InterleafError('mode-resolution-failed', 'Another agent session is already using this target or repository.');
    }
    const lockKey = input.sessionId;
    this.targetLocks.set(lockKey, { scope: lockScope });
    const sessionRoot = this.proveSessionPath(input.sessionId);
    const owner = await this.preparationOwner();
    const preparationBase = { version: 1, ownerId: randomUUID(), installationId: owner.installationId, sessionId: input.sessionId, sessionRoot, mode: input.mode } as const;
    let createdSessionRoot = false;
    let worktreeCreated = false;
    let branchName: string | null = null;
    const repositoryRoot: string | null = repositoryRootForLock;
    let worktreeRoot: string | null = null;
    let selectedRelativePath = '';
    try {
      await this.ensureRoot();
      if (await lstatIfExists(sessionRoot) !== null) throw new InterleafError('mode-resolution-failed', 'The app-owned session environment already exists.');
      await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      createdSessionRoot = true;
      // Item J: the owner marker is minted before anything else durable
      // exists, so every later step is provably ours and an interrupted
      // preparation is recognizable at startup without heuristics.
      await this.markPreparation(preparationBase, 'session-root');
      if (isPathWithin(targetPath, this.root)) {
        throw new InterleafError('mode-resolution-failed', 'The app-owned environment root is inside the selected target; isolation cannot be prepared safely.');
      }
      if (input.mode === 'container-sandbox') {
        const runtime = await this.detectRuntimeFn();
        if (runtime === null) throw new InterleafError('mode-resolution-failed', 'Container Sandbox is unavailable because Docker or Podman was not detected.');
        // Command execution in containers is intentionally not implied by
        // detection. A future adapter must assemble a rootless, network-off
        // command and prove its mounts before this mode can run.
        throw new InterleafError('mode-resolution-failed', `${runtime} was detected, but no verified Interleaf container executor is available.`);
      }
      // Items K/L: the index answer is taken once, before any copy or
      // snapshot, and everything this session ever does reads that same frozen
      // answer. A non-Git target has no index and keeps the name-only rules.
      const trackedIndex = input.mode === 'isolated-worktree' || await isGitRepository(targetPath, this.runGit)
        ? await readGitTrackedIndex(targetPath, this.runGit, isGeneratedName)
        : EMPTY_TRACKED_INDEX;
      await writeTrackedIndex(sessionRoot, trackedIndex, async () => { await this.triggerPrepareFault('tracked-index-record-temp'); });
      await this.markPreparation(preparationBase, 'tracked-index');
      let workspacePath = targetPath;
      let baselinePath = targetPath;
      let primaryWasDirty = false;
      let baseHead: string | null = null;
      let rootKind: Manifest['rootKind'] = 'active';
      if (input.mode === 'isolated-worktree') {
        rootKind = 'git';
        if (repositoryRoot === null) throw new InterleafError('mode-resolution-failed', 'Git repository identity could not be established.');
        baseHead = await this.runGit(repositoryRoot, ['rev-parse', 'HEAD']);
        primaryWasDirty = (await this.runGit(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length > 0;
        worktreeRoot = safeJoin(sessionRoot, 'worktree');
        branchName = agentSessionBranchName(input.sessionId);
        await writePendingCleanup({ version: 1, sessionId: input.sessionId, repositoryRoot, worktreeRoot, branchName, registered: false, committed: false }, sessionRoot);
        await this.runGit(repositoryRoot, ['worktree', 'add', '--quiet', '-b', branchName, worktreeRoot, baseHead]);
        worktreeCreated = true;
        await writePendingCleanup({ version: 1, sessionId: input.sessionId, repositoryRoot, worktreeRoot, branchName, registered: true, committed: false }, sessionRoot);
        await this.markPreparation(preparationBase, 'worktree-registered');
        // Item E: persisted in canonical `/` form, so a Windows host's
        // `packages\app` is stored and re-validated as `packages/app`.
        selectedRelativePath = toManifestRelativePath(relativePathBetween(repositoryRoot, targetPath), sep, 'the selected Git subdirectory');
        workspacePath = selectedRelativePath.length === 0 ? worktreeRoot : safeJoin(worktreeRoot, selectedRelativePath);
        if (!await isDirectoryPath(workspacePath)) throw new InterleafError('mode-resolution-failed', 'The selected Git subdirectory is absent from the isolated worktree.');
        baselinePath = join(sessionRoot, 'baseline');
        await copyBoundedDirectory(workspacePath, baselinePath, trackedIndex);
        await this.markPreparation(preparationBase, 'baseline');
      } else if (input.mode === 'isolated-copy') {
        rootKind = 'copy';
        workspacePath = join(sessionRoot, 'workspace');
        await copyBoundedDirectory(targetPath, workspacePath, trackedIndex);
        await this.markPreparation(preparationBase, 'workspace');
        baselinePath = join(sessionRoot, 'baseline');
        await copyBoundedDirectory(workspacePath, baselinePath, trackedIndex);
        await this.markPreparation(preparationBase, 'baseline');
      } else {
        // Direct modes still retain an app-owned immutable baseline so review
        // and patch export describe what the agent changed, rather than
        // comparing the modified target to itself.
        baselinePath = join(sessionRoot, 'baseline');
        await copyBoundedDirectory(targetPath, baselinePath, trackedIndex);
        await this.markPreparation(preparationBase, 'baseline');
      }

      const manifest: Manifest = {
        version: 1,
        rootKind,
        entries: await snapshotDirectory(this.snapshots, baselinePath, trackedIndex, { signal: this.sessionSignal(input.sessionId) }),
        createdAt: this.now().toISOString(),
      };
      await writeManifestFile(sessionRoot, manifest, async () => { await this.triggerPrepareFault('manifest-record-temp'); });
      await this.markPreparation(preparationBase, 'manifest');
      const { identity: targetIdentity } = await statWithIdentity(targetPath);
      const state: EnvironmentState = {
        sessionId: input.sessionId, mode: input.mode, targetPath, targetIdentity, workspacePath, workspaceRoot: worktreeRoot ?? workspacePath, selectedRelativePath, baselinePath, sessionRoot,
        manifest, primaryWasDirty, branchName, repositoryRoot, baseHead,
        containerRuntime: null, dangerousProfile: input.dangerousProfile === true, lockKey, lockScope, trackedIndex, indexFrozen: true, tests: [], suppressedTests: 0,
        runAdmitted: 0, runSuppressed: 0, runSummaryIndex: null, testsDirty: false, released: false, applied: false,
      };
      this.states.set(input.sessionId, state);
      await this.writeMetadata(state);
      await this.markPreparation(preparationBase, 'metadata');
      if (worktreeCreated && repositoryRoot !== null && worktreeRoot !== null && branchName !== null) {
        await writePendingCleanup({ version: 1, sessionId: input.sessionId, repositoryRoot, worktreeRoot, branchName, registered: true, committed: true }, sessionRoot);
        await unlink(join(sessionRoot, PENDING_CLEANUP_FILE));
      }
      // Item J: the commit point. A death before it leaves an owned,
      // uncommitted journal that startup cleans up exactly; a death between
      // the committed record and its removal leaves a committed journal that
      // startup simply discards.
      await writePreparationJournal(sessionRoot, { ...preparationBase, phase: 'metadata', committed: true }, owner);
      await removePreparationJournal(sessionRoot);
      const review = await this.buildReview(state);
      return { workspacePath, canonicalTargetPath: targetPath, review };
    } catch (error) {
      // Nothing is waiting for this session's scans any more, whichever unwind
      // path follows.
      this.cancelSession(input.sessionId);
      // Item J: a simulated process death is not a failure to unwind. It must
      // leave exactly the on-disk state a real crash would, so startup
      // recovery is what gets tested rather than this catch block.
      if (error instanceof PrepareInterruptedError) {
        this.states.delete(input.sessionId);
        this.targetLocks.delete(lockKey);
        throw new InterleafError('internal', 'Preparation was interrupted; the next startup will clean up the incomplete environment.');
      }
      if (worktreeCreated && repositoryRoot !== null && worktreeRoot !== null) {
        // `git worktree add` registers metadata outside the app-owned path;
        // unwind that registration before touching the session directory.
        try {
          await this.runGit(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot]);
          if (branchName !== null) await this.runGit(repositoryRoot, ['branch', '-D', branchName]);
          await unlink(join(sessionRoot, PENDING_CLEANUP_FILE)).catch(() => undefined);
        } catch (cleanupError) {
          // Keep the exact session record and lock. initialize() can retry the
          // bounded pending cleanup after a crash or a transient Git failure.
          throw new InterleafError('internal', 'Isolation preparation failed after Git registered a worktree. Recovery is required before this session path can be removed.', { cause: cleanupError instanceof Error ? cleanupError : null });
        }
      }
      this.states.delete(input.sessionId);
      this.targetLocks.delete(lockKey);
      if (createdSessionRoot) await this.safeCleanupFailedSession(sessionRoot).catch(() => undefined);
      if (error instanceof InterleafError) throw error;
      throw new InterleafError('mode-resolution-failed', 'Isolation preparation failed; no active fallback was attempted.', { cause: error instanceof Error ? error : null });
    }
  }

  /**
   * Records one agent-reported test result, or rejects it once the session's
   * bounded inventory is full. The outcome is explicit because the caller must
   * not create an artifact, rebuild the review, or schedule worker scans for a
   * result that was never accepted; a rejected result is still accounted for,
   * in one coalesced summary entry, so the flood remains visible.
   */
  /**
   * Opens a fresh admission window for a new run of this session (item I).
   *
   * The cap bounds what one run may amplify into artifacts, review rebuilds,
   * and metadata writes. Durable history is untouched: earlier runs' results
   * stay in the inventory, they simply no longer spend this run's budget.
   * Sessions with no prepared environment have nothing to bound.
   */
  beginTestRun(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state === undefined) return;
    state.runAdmitted = 0;
    state.runSuppressed = 0;
    state.runSummaryIndex = null;
  }

  /**
   * Decides one result synchronously, before any caller-side amplification.
   *
   * Admission has to come first: persisting, delivering, and scanning a result
   * the inventory is going to refuse is exactly the flood amplification the
   * cap exists to stop. Accepted results mark the inventory dirty for the
   * caller to flush; refused ones are folded into this run's single coalesced
   * summary and never write metadata by themselves.
   */
  admitTestResult(sessionId: string, result: EnvironmentTestResult): EnvironmentTestRecordOutcome {
    const state = this.requireState(sessionId);
    if (state.runAdmitted < TEST_RESULT_CAPACITY) {
      state.runAdmitted += 1;
      this.appendTestResult(state, result);
      state.testsDirty = true;
      return { accepted: true, recorded: state.tests.length, suppressed: state.suppressedTests };
    }
    state.suppressedTests += 1;
    state.runSuppressed += 1;
    const summary = coalescedTestSummary(state.runSuppressed, result);
    if (state.runSummaryIndex === null) {
      this.appendTestResult(state, summary);
      state.runSummaryIndex = state.tests.length - 1;
    } else {
      state.tests[state.runSummaryIndex] = summary;
    }
    state.testsDirty = true;
    return { accepted: false, recorded: state.tests.length, suppressed: state.suppressedTests };
  }

  /**
   * Writes the inventory once, if anything changed. Called after an admitted
   * result and at terminal/cancel/shutdown, so a refused flood costs one
   * bounded write for the whole run instead of one fsync per frame.
   */
  async flushTestInventory(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (state?.testsDirty !== true) return;
    state.testsDirty = false;
    await this.writeMetadata(state);
  }

  /** This run's coalesced summary, or `null` when nothing was refused. */
  suppressedTestSummary(sessionId: string): { readonly suppressed: number; readonly summary: EnvironmentTestResult } | null {
    const state = this.states.get(sessionId);
    if (state === undefined || state.runSuppressed === 0 || state.runSummaryIndex === null) return null;
    const summary = state.tests[state.runSummaryIndex];
    return summary === undefined ? null : { suppressed: state.runSuppressed, summary };
  }

  async recordTestResult(sessionId: string, result: EnvironmentTestResult): Promise<EnvironmentTestRecordOutcome> {
    const outcome = this.admitTestResult(sessionId, result);
    await this.flushTestInventory(sessionId);
    return outcome;
  }

  /** Durable history stays bounded overall, oldest entries first. */
  private appendTestResult(state: EnvironmentState, result: EnvironmentTestResult): void {
    state.tests.push(result);
    while (state.tests.length > MAX_RETAINED_TEST_RESULTS) {
      state.tests.shift();
      if (state.runSummaryIndex !== null) state.runSummaryIndex -= 1;
    }
    if (state.runSummaryIndex !== null && state.runSummaryIndex < 0) state.runSummaryIndex = null;
  }

  async containerAvailability(): Promise<ContainerRuntime | null> {
    return this.detectRuntimeFn();
  }

  async review(sessionId: string): Promise<AgentEnvironmentReviewResult> {
    const state = this.requireState(sessionId);
    await assertJournaledTargetIdentity(state);
    return { sessionId, review: await this.buildReview(state) };
  }

  async apply(sessionId: string): Promise<AgentEnvironmentReviewResult> {
    return this.withActionReservation(sessionId, 'apply', () => this.applyReserved(sessionId));
  }

  private async applyReserved(sessionId: string): Promise<AgentEnvironmentReviewResult> {
    const state = this.requireState(sessionId);
    if (state.applied) return { sessionId, review: await this.buildReview(state) };
    // Before any snapshot, staging directory, backup, or journal is written.
    await assertJournaledTargetIdentity(state);
    await this.protectedRoots.assertSelectable(state.targetPath);
    const review = await this.buildReview(state);
    if (!review.applyAllowed) throw new InterleafError('security-violation', review.applyDisabledReason ?? 'Changes cannot be applied from this environment.');
    if (state.primaryWasDirty) throw new InterleafError('security-violation', 'Apply is disabled because the primary Git worktree was dirty when this session started.');
    if (state.mode === 'isolated-worktree' && state.repositoryRoot !== null && state.baseHead !== null) {
      const currentRoot = await this.runGit(state.targetPath, ['rev-parse', '--show-toplevel']);
      if (resolve(currentRoot) !== resolve(state.repositoryRoot)) throw new InterleafError('security-violation', 'The primary repository identity changed while the agent was running.');
      if (await this.runGit(state.repositoryRoot, ['rev-parse', 'HEAD']) !== state.baseHead) throw new InterleafError('security-violation', 'The primary repository HEAD changed while the agent was running. Apply was blocked.');
      if ((await this.runGit(state.repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length > 0) throw new InterleafError('security-violation', 'The primary repository became dirty while the agent was running. Apply was blocked.');
      if (!await isRegisteredWorktree(state.repositoryRoot, state.workspaceRoot, this.runGit)) throw new InterleafError('security-violation', 'The isolated Git worktree is no longer registered.');
      if (state.branchName !== null && await this.runGit(state.workspaceRoot, ['symbolic-ref', '--short', 'HEAD']) !== state.branchName) throw new InterleafError('security-violation', 'The isolated Git worktree branch identity changed.');
    }
    const signal = this.sessionSignal(sessionId);
    const currentTarget = await snapshotDirectory(this.snapshots, state.targetPath, state.trackedIndex, { signal });
    if (!sameManifestEntries(state.manifest.entries, currentTarget)) throw new InterleafError('security-violation', 'The selected directory changed while the agent was running; apply was blocked to prevent drift overwrite.');
    const currentWorkspace = await snapshotDirectory(this.snapshots, state.workspacePath, state.trackedIndex, { signal });
    const plan = buildChangePlan(state.manifest.entries, currentWorkspace);
    assertNoSymlinkChanges(plan);
    const transactionId = randomUUID();
    const recovery = safeJoin(state.sessionRoot, `recovery-${transactionId}`);
    const stage = join(dirname(state.targetPath), `.interleaf-stage-${state.sessionId}`);
    if (!isPathWithin(dirname(state.targetPath), stage) || basename(stage) !== `.interleaf-stage-${state.sessionId}`) {
      throw new InterleafError('security-violation', 'The app-owned staging path could not be proven safe.');
    }
    if (await lstatIfExists(stage) !== null) throw new InterleafError('security-violation', 'A previous incomplete apply transaction still owns the staging path.');
    // Re-proved here, not only at entry. The review, the Git inspections, and
    // both directory snapshots above are an unbounded window in which the
    // target could be replaced, repointed through a symlink, or moved under a
    // protected application-data root. This is the last check before any
    // mutation state exists: nothing has been created or touched yet, so a
    // rejection leaves the target and the session exactly as they were. The
    // remaining same-user race between this check and the individual mutation
    // syscalls below is narrow and irreducible without kernel support; the
    // per-entry symlink, ancestor, and expected-entry checks bound it.
    //
    // Order matters. `assertSelectable` canonicalizes the candidate and then
    // awaits canonicalization of every configured root, so it is itself a
    // window in which the target can be replaced after its own candidate
    // lookup. The policy therefore runs first and the persisted file-identity
    // proof runs last, directly before the first byte of mutation state, so no
    // await separates the final identity proof from the recovery directory.
    await this.protectedRoots.assertSelectable(state.targetPath);
    await assertJournaledTargetIdentity(state);
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    const previousManifest = state.manifest;
    const previousMetadataValue: PortableValue = parsePortableJson(await readFile(join(state.sessionRoot, 'environment.json'), 'utf8'));
    if (!isPortableRecord(previousMetadataValue)) throw new InterleafError('internal', 'The environment metadata could not be journaled safely.');
    const initialJournal: ApplyJournal = {
      version: 2, state: 'prepared', transactionId, sessionId, mode: state.mode as 'isolated-copy' | 'isolated-worktree', targetPath: state.targetPath,
      sessionRoot: state.sessionRoot, stagePath: stage, recoveryPath: recovery,
      createdDirectories: [], backups: [], previousManifest, previousMetadata: previousMetadataValue,
    };
    await writeApplyJournal(recovery, initialJournal);
    // The durable journal must exist before the sibling staging directory is
    // created. A process death in the setup window can therefore only leave a
    // recoverable pre-mutation journal (or the bounded atomic-write temp).
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const expected = new Map(state.manifest.entries.map((entry) => [entry.path, entry]));
    const missingParentDirectories = await collectMissingTargetParents(state.targetPath, [
      ...plan.files.map((change) => change.path),
      ...plan.createdDirectories,
    ]);
    const createdDirectories = [...new Set([
      ...missingParentDirectories,
      ...plan.createdDirectories.map((path) => safeJoin(state.targetPath, path)),
    ])];
    const backups: ApplyBackup[] = [];
    // Item G: one budget for the whole *backup* pass, so a thousand
    // individually reasonable copies cannot collectively exhaust the disk.
    // Validation and restoration are separate passes over the same bytes and
    // get their own allowances in `rollbackApply`: charging them here would
    // make a legitimate restore fail on arithmetic, with the target gone.
    const backupBudget = createBackupBudget();
    let journal: ApplyJournal = {
      ...initialJournal,
      createdDirectories: createdDirectories.map((created) => relativePathBetween(state.targetPath, created).split(sep).join('/')),
    };
    await writeApplyJournal(recovery, journal);
    let journalCommitted = false;
    try {
      const backupPaths = topLevelPaths([
        ...plan.files.map((change) => change.path),
        ...plan.deletedDirectories,
      ]);
      for (const path of backupPaths) {
        const target = safeJoin(state.targetPath, path);
        await assertNoSymlinkAncestors(state.targetPath, target);
        const targetStat = await lstatIfExists(target);
        const expectedEntry = expected.get(path);
        await assertExpectedEntry(target, expectedEntry);
        if (targetStat?.isSymbolicLink() === true) throw new InterleafError('security-violation', `Refusing to apply through a symbolic link: ${path}`);
        const backup = targetStat === null ? null : safeJoin(recovery, path);
        if (backup !== null && targetStat !== null) {
          await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
          await copyBackupEntry(target, backup, targetStat, backupBudget);
        }
        backups.push({ target, backup, existed: targetStat !== null });
        journal = {
          ...journal,
          createdDirectories: createdDirectories.map((created) => relativePathBetween(state.targetPath, created).split(sep).join('/')),
          backups: backups.map((item) => ({ relativePath: relativePathBetween(state.targetPath, item.target).split(sep).join('/'), backupRelativePath: item.backup === null ? null : relativePathBetween(recovery, item.backup).split(sep).join('/'), existed: item.existed })),
        };
        await writeApplyJournal(recovery, journal);
      }
      // Remove only old nodes that are being replaced. Directory removal is
      // handled separately, deepest-first, so children are never staged twice.
      for (const change of plan.files) {
        if (change.kind === 'deleted') continue;
        const source = safeJoin(state.workspacePath, change.path);
        await assertNoSymlinkAncestors(state.workspacePath, source);
        const sourceEntry = findEntry(currentWorkspace, change.path);
        await assertExpectedEntry(source, sourceEntry);
        const staged = safeJoin(stage, change.path);
        await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
        const sourceStat = await lstat(source);
        if (sourceStat.isSymbolicLink()) throw new InterleafError('security-violation', `Unsupported source entry during apply: ${change.path}`);
        if (!sourceStat.isFile()) continue;
        await copyFile(source, staged, fsConstants.COPYFILE_EXCL);
        const sourceMode = sourceStat.mode & 0o777;
        await chmod(staged, sourceMode);
        await assertExpectedEntry(staged, sourceEntry);
      }
      for (const change of plan.files) {
        const target = safeJoin(state.targetPath, change.path);
        await assertNoSymlinkAncestors(state.targetPath, target);
        const existing = await lstatIfExists(target);
        await assertExpectedEntry(target, expected.get(change.path));
        if (change.kind === 'deleted') {
          if (existing !== null) await rm(target, { recursive: true, force: true });
          await this.afterTargetMutation(state, change.path);
          continue;
        }
        const staged = safeJoin(stage, change.path);
        const sourcePath = safeJoin(state.workspacePath, change.path);
        const sourceStat = await lstat(sourcePath);
        const sourceEntry = findEntry(currentWorkspace, change.path);
        await assertExpectedEntry(sourcePath, sourceEntry);
        if (sourceStat.isDirectory()) {
          if (existing?.isDirectory() === true) {
            await chmod(target, sourceStat.mode & 0o777);
          } else {
            if (existing !== null) await rm(target, { recursive: true, force: true });
            await mkdir(target, { recursive: true, mode: sourceStat.mode & 0o777 });
          }
          await this.afterTargetMutation(state, change.path);
          continue;
        }
        const destinationWasReplaced = existing !== null && !existing.isFile();
        if (destinationWasReplaced) await rm(target, { recursive: true, force: true });
        await ensureTargetParentDirectories(state.targetPath, dirname(target), currentWorkspace);
        await assertNoSymlinkAncestors(state.targetPath, target);
        await assertExpectedEntry(sourcePath, sourceEntry);
        await assertExpectedEntry(staged, sourceEntry);
        await assertExpectedEntry(target, destinationWasReplaced ? undefined : expected.get(change.path));
        await rename(staged, target);
        await this.afterTargetMutation(state, change.path);
      }
      for (const path of [...plan.createdDirectories].sort((a, b) => a.split('/').length - b.split('/').length)) {
        const target = safeJoin(state.targetPath, path);
        await assertNoSymlinkAncestors(state.targetPath, target);
        const existing = await lstatIfExists(target);
        if (existing?.isSymbolicLink() === true) throw new InterleafError('security-violation', `Refusing to create through a symbolic link: ${path}`);
        if (existing?.isFile() === true) {
          await assertExpectedEntry(target, expected.get(path));
          await rm(target, { force: true });
        }
        const desiredMode = findEntry(currentWorkspace, path)?.mode ?? 0o755;
        await mkdir(target, { recursive: true, mode: desiredMode });
        await chmod(target, desiredMode);
        await this.afterTargetMutation(state, path);
      }
      for (const path of [...plan.deletedDirectories].sort((a, b) => b.split('/').length - a.split('/').length)) {
        const target = safeJoin(state.targetPath, path);
        await assertNoSymlinkAncestors(state.targetPath, target);
        const existing = await lstatIfExists(target);
        await assertExpectedEntry(target, expected.get(path));
        if (existing !== null) await rm(target, { recursive: true, force: true });
        await this.afterTargetMutation(state, path);
      }
      state.manifest = { ...state.manifest, entries: currentWorkspace, createdAt: this.now().toISOString() };
      await writeManifestFile(state.sessionRoot, state.manifest);
      state.applied = true;
      await this.writeMetadata(state, true);
      await this.triggerApplyFault('before-journal-commit');
      // Compute the final review while the prepared journal is still
      // recoverable. A review failure therefore follows the normal rollback
      // path before a committed marker can claim the target is complete.
      const finalReview = await this.buildReview(state);
      journal = { ...journal, state: 'committed' };
      await writeApplyJournal(recovery, journal);
      await this.triggerApplyFault('after-journal-commit');
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
      journalCommitted = true;
      return { sessionId, review: finalReview };
    } catch (error) {
      if (error instanceof ApplyInterruptedError) throw new InterleafError('internal', 'Apply was interrupted; the next startup will restore the primary directory from its recovery journal.');
      state.manifest = previousManifest;
      state.applied = false;
      // Every step runs whatever the one before it did; the first failure is
      // the one reported, and any of them leaves the recovery backup in place.
      let rollbackError: Error | null = null;
      for (const step of [
        () => this.rollbackApply(backups, state.targetPath, recovery),
        () => removeEmptyCreatedDirectories(createdDirectories, state.targetPath),
        () => writeManifestFile(state.sessionRoot, previousManifest),
        () => writeAtomicMetadata(state.sessionRoot, JSON.stringify(previousMetadataValue)),
        () => rm(stage, { recursive: true, force: true }),
      ]) {
        const failure = await failureOf(step);
        rollbackError ??= failure;
      }
      if (rollbackError === null && !journalCommitted) await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
      if (rollbackError !== null) {
        throw new InterleafError('internal', 'Apply failed and recovery rollback did not complete. The recovery backup is preserved for retry.', { cause: rollbackError });
      }
      if (error instanceof InterleafError) throw error;
      throw new InterleafError('internal', 'Applying agent changes failed; the primary directory was restored from recovery.', { cause: toError(error instanceof Error ? error : null) });
    }
  }

  async exportPatch(sessionId: string): Promise<AgentPatchExportResult> {
    return this.withActionReservation(sessionId, 'export-patch', () => this.exportPatchReserved(sessionId));
  }

  private async exportPatchReserved(sessionId: string): Promise<AgentPatchExportResult> {
    const state = this.requireState(sessionId);
    const review = await this.buildReview(state);
    if (!review.patchAvailable) throw new InterleafError('validation', review.changedFiles.length === 0 ? 'There are no changes to export.' : 'Binary or oversized copy changes cannot be exported as an applicable patch; use Apply Changes instead.');
    const patch = await renderBoundedPatch(state, review.changedFiles);
    const artifactId = randomUUID();
    const fileName = `interleaf-${sessionId.slice(0, 8)}.patch`;
    const saved = await this.savePatchFn(fileName, patch);
    return saved ? { outcome: 'exported', artifactId, fileName, bytes: Buffer.byteLength(patch, 'utf8') } : { outcome: 'cancelled' };
  }

  async openFolder(sessionId: string): Promise<{ readonly opened: boolean }> {
    return this.withActionReservation(sessionId, 'open-folder', () => this.openFolderReserved(sessionId));
  }

  private async openFolderReserved(sessionId: string): Promise<{ readonly opened: boolean }> {
    const state = this.requireState(sessionId);
    await assertJournaledTargetIdentity(state);
    return { opened: await this.openFolderFn(state.workspacePath) };
  }

  async discard(sessionId: string): Promise<void> {
    return this.withActionReservation(sessionId, 'discard', () => this.discardReserved(sessionId));
  }

  private async discardReserved(sessionId: string): Promise<void> {
    // The session is going away: stop any scan it still owns before the
    // workspace those scans are walking is removed.
    this.cancelSession(sessionId);
    const state = this.states.get(sessionId);
    if (state === undefined) {
      // A failed prepare can leave only the durable Git cleanup record (no
      // EnvironmentState was committed yet). Never report that as a successful
      // discard or let a caller clear its sole persisted management reference.
      const pending = await readPendingCleanup(this.proveSessionPath(sessionId));
      if (pending.status !== 'absent') throw new InterleafError('internal', 'Git isolation cleanup is still pending or its record is unreadable; retry after recovery succeeds.');
      return;
    }
    if (state.released) return;
    // Cleanup is deliberately retryable. State and locks remain authoritative
    // until every external Git registration and app-owned path is gone.
    if (state.mode === 'isolated-worktree' && state.repositoryRoot !== null) {
      if (await isRegisteredWorktree(state.repositoryRoot, state.workspaceRoot, this.runGit)) {
        await this.runGit(state.repositoryRoot, ['worktree', 'remove', '--force', state.workspaceRoot]);
        if (await isRegisteredWorktree(state.repositoryRoot, state.workspaceRoot, this.runGit)) throw new InterleafError('internal', 'Git worktree cleanup did not remove the registered worktree.');
      }
      if (state.branchName !== null && await gitBranchExists(state.repositoryRoot, state.branchName, this.runGit)) {
        await this.runGit(state.repositoryRoot, ['branch', '-D', state.branchName]);
        if (await gitBranchExists(state.repositoryRoot, state.branchName, this.runGit)) throw new InterleafError('internal', 'Git branch cleanup did not remove the session branch.');
      }
    }
    await this.removeProvenSession(state.sessionRoot);
    state.released = true;
    this.states.delete(sessionId);
    this.cancellations.delete(sessionId);
    this.targetLocks.delete(state.lockKey);
  }

  async release(sessionId: string): Promise<void> { await this.discard(sessionId); }

  assertResumeAvailable(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state === undefined || state.released) throw new InterleafError('validation', 'The agent environment is no longer available; start a new session instead.');
    if (state.applied) throw new InterleafError('validation', 'This agent environment was already applied; start a new session instead.');
    // Synchronous half of the durable-identity contract; the full canonical
    // re-check runs in the async resume path before anything is spawned.
    if (state.targetIdentity === null || !hasProvableIdentity(state.targetIdentity)) {
      throw new InterleafError('security-violation', 'This agent environment has no durable target identity and cannot be continued.');
    }
  }

  getWorkspacePath(sessionId: string): string { return this.requireState(sessionId).workspacePath; }

  async getReview(sessionId: string): Promise<AgentEnvironmentReview | null> {
    const state = this.states.get(sessionId);
    return state === undefined ? null : this.buildReview(state);
  }

  private async afterTargetMutation(_state: EnvironmentState, relativePath: string): Promise<void> {
    await this.triggerApplyFault('after-target-mutation', relativePath);
    // Keep the state argument in the seam so a future fault injector cannot
    // accidentally be given an unvalidated absolute target path.
  }

  private async triggerApplyFault(phase: 'after-target-mutation' | 'after-metadata-temp-write' | 'before-journal-commit' | 'after-journal-commit', relativePath = ''): Promise<void> {
    const result = await this.applyFaultInjector?.({ phase, relativePath });
    if (result === 'process-death') throw new ApplyInterruptedError();
  }

  private async recoverApplyJournals(): Promise<void> {
    let sessionEntries: string[];
    try { sessionEntries = await readdir(this.root); } catch { return; }
    for (const sessionId of sessionEntries) {
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const sessionRoot = this.proveSessionPath(sessionId);
      const sessionDetails = await lstatIfExists(sessionRoot);
      if (sessionDetails === null || !sessionDetails.isDirectory() || sessionDetails.isSymbolicLink()) throw new InterleafError('security-violation', 'An app-owned session recovery root is not a canonical directory.');
      await cleanupAtomicMetadataTemp(sessionRoot);
      let children: string[];
      try { children = await readdir(sessionRoot); } catch { continue; }
      for (const child of children) {
        if (!/^recovery-[a-f0-9-]{36}$/iu.test(child)) continue;
        const recovery = safeJoin(sessionRoot, child);
        const recoveryDetails = await lstatIfExists(recovery);
        if (recoveryDetails === null || !recoveryDetails.isDirectory() || recoveryDetails.isSymbolicLink()) throw new InterleafError('security-violation', 'An apply recovery directory is not a canonical app-owned directory.');
        const transactionPath = safeJoin(recovery, 'transaction.json');
        const details = await lstatIfExists(transactionPath);
        if (details === null) {
          await recoverPreJournalShape(sessionRoot, recovery, sessionId);
          continue;
        }
        if (!details.isFile() || details.size > MAX_RECOVERY_JOURNAL_BYTES) throw new InterleafError('security-violation', 'An apply recovery journal is missing or exceeds the bounded recovery limit.');
        const parsed: PortableValue = parsePortableJson(await readFile(transactionPath, 'utf8'));
        const journal = await parseApplyJournal(parsed, sessionRoot, recovery, this.runGit);
        if (journal.state === 'committed') {
          await removeOwnedDirectory(journal.stagePath, dirname(journal.targetPath));
          await removeOwnedDirectory(journal.recoveryPath, journal.sessionRoot);
          continue;
        }
        await rollbackApplyJournal(journal);
      }
    }
  }

  /**
   * Derives the review a caller sees for one environment.
   *
   * `protected` rather than `private` so the apply-window suite can subclass
   * this manager and act inside the await it opens; nothing outside this class
   * calls it in production.
   */
  protected async buildReview(state: EnvironmentState): Promise<AgentEnvironmentReview> {
    return this.snapshots.operation(() => this.buildReviewAdmitted(state));
  }

  private async buildReviewAdmitted(state: EnvironmentState): Promise<AgentEnvironmentReview> {
    const current = await snapshotDirectory(this.snapshots, state.workspacePath, state.trackedIndex, { signal: this.sessionSignal(state.sessionId) });
    const plan = buildChangePlan(state.manifest.entries, current);
    // Item L: link changes are reported so the user can see them, but they are
    // never diffed — rendering one would mean reading through it.
    const changedFiles = [...plan.files, ...plan.symlinkChanges].sort((left, right) => left.path.localeCompare(right.path));
    const diff = plan.files.length === 0 ? null : await renderBoundedPatch(state, plan.files);
    const applyDisabledReason = applyRefusalReason(state, plan);
    return {
      mode: state.mode,
      // Item N: the persisted level the renderer renders comes from the same
      // predicate the confirmation used.
      riskLevel: resolveAgentRiskLevel({ mode: state.mode, dangerousProfile: state.dangerousProfile }),
      workspaceLabel: state.mode === 'active-env' || state.mode === 'native-restricted' ? 'Selected working directory' : 'Interleaf isolated workspace',
      primaryWasDirty: state.primaryWasDirty,
      applyAllowed: applyDisabledReason === null && !state.applied,
      applyDisabledReason,
      applied: state.applied,
      activeWorkspaceModified: (state.mode === 'active-env' || state.mode === 'native-restricted') && changedFiles.length > 0,
      changedFiles,
      tests: [...state.tests],
      diffAvailable: plan.files.length > 0,
      diff,
      patchAvailable: plan.files.length > 0 && plan.symlinkChanges.length === 0 && diff !== null && !diff.includes('Binary files '),
      containerRuntime: state.containerRuntime,
    };
  }

  private requireState(sessionId: string): EnvironmentState {
    const state = this.states.get(sessionId);
    if (state === undefined || state.released) throw new InterleafError('validation', 'The agent environment is no longer available.');
    return state;
  }

  private async withActionReservation<T>(sessionId: string, action: EnvironmentAction, operation: () => Promise<T>): Promise<T> {
    const existing = this.actionReservations.get(sessionId);
    if (existing !== undefined) throw new InterleafError('validation', `Environment action "${existing}" is already in progress for this session.`);
    this.actionReservations.set(sessionId, action);
    try {
      return await operation();
    } finally {
      if (this.actionReservations.get(sessionId) === action) this.actionReservations.delete(sessionId);
    }
  }

  private proveSessionPath(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) throw new InterleafError('security-violation', 'Invalid app-owned session path.');
    return safeJoin(this.root, sessionId);
  }

  private async writeMetadata(state: EnvironmentState, applyFaultBoundary = false): Promise<void> {
    const metadata = {
      version: 1, sessionId: state.sessionId, mode: state.mode, targetPath: state.targetPath,
      // Item K/L durability marker: this session froze a tracked-index record,
      // so a later startup that cannot find one must fail closed rather than
      // read the absence as a legacy name-only environment.
      indexVersion: 1,
      targetIdentity: state.targetIdentity,
      workspacePath: state.workspacePath, workspaceRoot: state.workspaceRoot, selectedRelativePath: state.selectedRelativePath, baselinePath: state.baselinePath, sessionRoot: state.sessionRoot, primaryWasDirty: state.primaryWasDirty,
      branchName: state.branchName, repositoryRoot: state.repositoryRoot, baseHead: state.baseHead,
      lockKey: state.lockKey, lockScope: state.lockScope, containerRuntime: state.containerRuntime, dangerousProfile: state.dangerousProfile, applied: state.applied, tests: state.tests, suppressedTests: state.suppressedTests,
    };
    await writeAtomicMetadata(state.sessionRoot, JSON.stringify(metadata), applyFaultBoundary ? () => this.triggerApplyFault('after-metadata-temp-write') : undefined);
  }

  /**
   * Item J: makes one preparation step durable, then offers the test-only
   * crash seam. The journal is written *before* the fault fires, so the
   * injected death leaves the same record a real one would.
   */
  private async markPreparation(base: Omit<PreparationJournal, 'phase' | 'committed'>, phase: PreparationPhase): Promise<void> {
    await writePreparationJournal(base.sessionRoot, { ...base, phase, committed: false }, await this.preparationOwner(), async () => {
      await this.triggerPrepareFault(`${phase}-temp`);
    });
    await this.triggerPrepareFault(phase);
  }

  private async triggerPrepareFault(phase: PreparationFaultPhase): Promise<void> {
    if (await this.prepareFaultInjector?.({ phase }) === 'process-death') throw new PrepareInterruptedError();
  }

  /**
   * Item G: the *complete* backup set is proved restorable, on its own fresh
   * budget, before the first target is removed. The apply budget that paid for
   * the backup copies is deliberately not reused: it is already consumed, and
   * charging validation and restoration to it again turned a legitimate restore
   * into a budget failure with the target already deleted.
   */
  private async rollbackApply(backups: readonly { readonly target: string; readonly backup: string | null; readonly existed: boolean }[], targetRoot: string, recoveryRoot: string): Promise<void> {
    const proven = await preflightRestore(recoveryRoot, backups);
    const restoreBudget = createBackupBudget();
    for (const item of [...backups].reverse()) {
      await assertNoSymlinkAncestors(targetRoot, item.target);
      if (item.backup === null) {
        await removeCreatedEntry(item.target, restoreBudget);
        continue;
      }
      const backupStat = proven.get(item.backup);
      if (backupStat === undefined) throw new InterleafError('internal', 'A recovery backup was not proved before restoration.');
      await rm(item.target, { recursive: true, force: true });
      await mkdir(dirname(item.target), { recursive: true, mode: 0o755 });
      await copyBackupEntry(item.backup, item.target, backupStat, restoreBudget);
    }
  }

  private async removeProvenSession(candidate: string): Promise<void> {
    const proven = safeJoin(this.root, basename(candidate));
    if (proven !== candidate || !SESSION_ID_RE.test(basename(candidate))) throw new InterleafError('security-violation', 'Refusing to remove an unproven environment path.');
    await rm(proven, { recursive: true, force: true });
  }

  private async safeCleanupFailedSession(candidate: string): Promise<void> {
    try { await this.removeProvenSession(candidate); } catch { /* never widen cleanup scope */ }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const details = await lstat(this.root);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new InterleafError('security-violation', 'The app-owned environment root is not a canonical directory.');
  }
}

async function detectContainerRuntime(): Promise<ContainerRuntime | null> {
  for (const runtime of ['docker', 'podman'] as const) {
    try {
      await execFileBounded(runtime, ['--version'], { shell: false, encoding: 'utf8', env: buildMinimalChildEnvironment(), timeout: 2_000, maxBuffer: 4_096, windowsHide: true });
      return runtime;
    } catch { /* probe next runtime */ }
  }
  return null;
}

class ApplyInterruptedError extends Error {
  constructor() { super('simulated process death'); }
}

class PrepareInterruptedError extends Error {
  constructor() { super('simulated process death during preparation'); }
}

/**
 * The one durable-write primitive every session record uses: bounded size,
 * `O_EXCL` temp, `fsync` of the file, `rename`, then `fsync` of the directory.
 *
 * `manifest.json` and `tracked-index.json` used a plain `writeFile`. Both are
 * read back at startup and both decide what the session's baseline *means*, so
 * a torn or unflushed write could leave a session whose journal says the step
 * committed and whose record says something else — or nothing. They now take
 * the same path as `environment.json`, and each one's directory entry is
 * durable before the preparation journal may record the step.
 */
async function writeAtomicSessionFile(record: SessionRecordKind, sessionRoot: string, serialized: string, afterTempWrite?: () => Promise<void>): Promise<void> {
  if (Buffer.byteLength(serialized, 'utf8') > record.maxBytes) throw new InterleafError('validation', `The ${record.label} exceeds the bounded limit.`);
  const finalPath = safeJoin(sessionRoot, record.fileName);
  const temporary = safeJoin(sessionRoot, record.temporaryName);
  await assertNoSymlinkAncestors(sessionRoot, temporary);
  const existingTemporary = await lstatIfExists(temporary);
  if (existingTemporary !== null) {
    if (!existingTemporary.isFile() || existingTemporary.isSymbolicLink() || existingTemporary.size > record.maxBytes) throw new InterleafError('security-violation', `The ${record.label} temporary is unsafe or exceeds the bounded limit.`);
    await unlink(temporary);
  }
  const existingFinal = await lstatIfExists(finalPath);
  if (existingFinal?.isSymbolicLink() === true) throw new InterleafError('security-violation', `The ${record.label} path is symbolic-linked.`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    await afterTempWrite?.();
  } finally {
    await handle.close();
  }
  await rename(temporary, finalPath);
  await syncDirectory(sessionRoot);
}

async function writeAtomicMetadata(sessionRoot: string, serialized: string, afterTempWrite?: () => Promise<void>): Promise<void> {
  await writeAtomicSessionFile(METADATA_RECORD, sessionRoot, serialized, afterTempWrite);
}

async function writeManifestFile(sessionRoot: string, manifest: Manifest, afterTempWrite?: () => Promise<void>): Promise<void> {
  await writeAtomicSessionFile(MANIFEST_RECORD, sessionRoot, JSON.stringify(manifest), afterTempWrite);
}

async function cleanupAtomicTemp(record: SessionRecordKind, sessionRoot: string): Promise<void> {
  const temporary = safeJoin(sessionRoot, record.temporaryName);
  await assertNoSymlinkAncestors(sessionRoot, temporary);
  const details = await lstatIfExists(temporary);
  if (details === null) return;
  if (!details.isFile() || details.isSymbolicLink() || details.size > record.maxBytes) throw new InterleafError('security-violation', `The ${record.label} temporary is unsafe or exceeds the bounded limit.`);
  await unlink(temporary);
}

async function cleanupAtomicMetadataTemp(sessionRoot: string): Promise<void> {
  for (const record of SESSION_RECORDS) await cleanupAtomicTemp(record, sessionRoot);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code !== 'EBADF' && code !== 'EISDIR' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  }
}

async function writeApplyJournal(recovery: string, journal: ApplyJournal): Promise<void> {
  const serialized = JSON.stringify(journal);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_JOURNAL_BYTES) throw new InterleafError('validation', 'The apply recovery journal exceeds the bounded limit.');
  const temporary = safeJoin(recovery, '.transaction.json.tmp');
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, safeJoin(recovery, 'transaction.json'));
}

async function recoverPreJournalShape(sessionRoot: string, recovery: string, sessionId: string): Promise<void> {
  const recoveryEntries = await readdir(recovery);
  if (recoveryEntries.length > 1 || (recoveryEntries.length === 1 && recoveryEntries[0] !== '.transaction.json.tmp')) {
    throw new InterleafError('security-violation', 'An apply recovery directory without a journal contains an unexpected entry.');
  }
  if (recoveryEntries.length === 1) {
    const temporary = safeJoin(recovery, '.transaction.json.tmp');
    const details = await lstatIfExists(temporary);
    if (details === null || !details.isFile() || details.isSymbolicLink() || details.size > MAX_RECOVERY_JOURNAL_BYTES) throw new InterleafError('security-violation', 'The pre-journal recovery temporary is unsafe or exceeds the bounded limit.');
    await unlink(temporary);
  }
  const metadataPath = safeJoin(sessionRoot, 'environment.json');
  const metadataDetails = await lstatIfExists(metadataPath);
  if (metadataDetails === null || !metadataDetails.isFile() || metadataDetails.isSymbolicLink() || metadataDetails.size > 128 * 1024) throw new InterleafError('security-violation', 'The pre-journal session metadata is missing or unsafe.');
  const state = parseMetadata(parsePortableJson(await readFile(metadataPath, 'utf8')));
  if (state.sessionId !== sessionId || resolve(state.sessionRoot) !== resolve(sessionRoot) || (state.mode !== 'isolated-copy' && state.mode !== 'isolated-worktree')) throw new InterleafError('security-violation', 'The pre-journal session metadata is not an exact isolated environment.');
  const targetPath = await canonicalDirectory(state.targetPath);
  if (resolve(state.targetPath) !== targetPath) throw new InterleafError('security-violation', 'The pre-journal target path is not canonical.');
  const stage = join(dirname(targetPath), `.interleaf-stage-${sessionId}`);
  await assertNoSymlinkAncestors(dirname(targetPath), stage);
  await removeOwnedDirectory(stage, dirname(targetPath));
  await removeOwnedDirectory(recovery, sessionRoot);
}

async function parseApplyJournal(value: PortableValue, sessionRoot: string, recovery: string, runGit: GitRunner): Promise<ApplyJournal> {
  if (!isPortableRecord(value) || value.version !== 2 || (value.state !== 'prepared' && value.state !== 'committed') || typeof value.transactionId !== 'string' || !SESSION_ID_RE.test(value.transactionId) || typeof value.sessionId !== 'string' || value.sessionId !== basename(sessionRoot) || (value.mode !== 'isolated-copy' && value.mode !== 'isolated-worktree') || typeof value.targetPath !== 'string' || typeof value.sessionRoot !== 'string' || resolve(value.sessionRoot) !== resolve(sessionRoot) || typeof value.stagePath !== 'string' || typeof value.recoveryPath !== 'string' || resolve(value.recoveryPath) !== resolve(recovery) || !isPortableArray(value.createdDirectories) || !isPortableArray(value.backups) || !isPortableRecord(value.previousMetadata)) throw new InterleafError('security-violation', 'The apply recovery journal is malformed.');
  // The journal is an untrusted recovery hint. Bind every identity-bearing
  // field to the independently validated session metadata before touching an
  // external target or interpreting a backup path.
  const sessionMetadata = await readValidatedRecoveryMetadata(sessionRoot, basename(sessionRoot), runGit);
  const targetPath = sessionMetadata.state.targetPath;
  if (sessionMetadata.state.sessionId !== value.sessionId || sessionMetadata.state.mode !== value.mode || !samePath(value.targetPath, targetPath)) throw new InterleafError('security-violation', 'The apply recovery journal does not match the current session metadata.');
  const expectedStage = join(dirname(targetPath), `.interleaf-stage-${value.sessionId}`);
  if (resolve(value.stagePath) !== resolve(expectedStage)) throw new InterleafError('security-violation', 'The apply recovery staging path is not the exact app-owned target sibling.');
  await assertNoSymlinkAncestors(dirname(targetPath), expectedStage);
  await assertNoSymlinkAncestors(sessionRoot, recovery);
  if (!isValidManifest(value.previousManifest)) throw new InterleafError('security-violation', 'The apply recovery journal contains an invalid previous manifest.');
  if (value.createdDirectories.length > MAX_CHANGE_ENTRIES || value.backups.length > MAX_CHANGE_ENTRIES) throw new InterleafError('validation', 'The apply recovery journal exceeds bounded entry limits.');
  const createdDirectories = value.createdDirectories.map((item) => {
    if (typeof item !== 'string' || !isSafeRelativePath(item)) throw new InterleafError('security-violation', 'The apply recovery journal contains an unsafe created-directory path.');
    return item;
  });
  const backups = value.backups.map((item) => {
    if (!isPortableRecord(item) || typeof item.relativePath !== 'string' || !isSafeRelativePath(item.relativePath) || (item.backupRelativePath !== null && (typeof item.backupRelativePath !== 'string' || !isSafeRelativePath(item.backupRelativePath))) || typeof item.existed !== 'boolean' || (item.existed && item.backupRelativePath === null) || (!item.existed && item.backupRelativePath !== null)) throw new InterleafError('security-violation', 'The apply recovery journal contains an unsafe backup record.');
    safeJoin(targetPath, item.relativePath);
    if (item.backupRelativePath !== null) safeJoin(recovery, item.backupRelativePath);
    return { relativePath: item.relativePath, backupRelativePath: item.backupRelativePath, existed: item.existed };
  });
  if (Buffer.byteLength(JSON.stringify(value.previousMetadata), 'utf8') > 128 * 1024) throw new InterleafError('validation', 'The apply recovery metadata exceeds the bounded limit.');
  const previousMetadata = validateBoundRecoveryMetadata(value.previousMetadata, sessionMetadata);
  return {
    version: 2,
    state: value.state,
    transactionId: value.transactionId,
    sessionId: value.sessionId,
    mode: value.mode,
    targetPath,
    sessionRoot,
    stagePath: expectedStage,
    recoveryPath: recovery,
    createdDirectories,
    backups,
    previousManifest: value.previousManifest,
    previousMetadata,
  };
}

type ValidatedRecoveryMetadata = { readonly state: EnvironmentState; readonly raw: PortableRecord };

async function readValidatedRecoveryMetadata(sessionRoot: string, sessionId: string, runGit: GitRunner): Promise<ValidatedRecoveryMetadata> {
  const metadataPath = safeJoin(sessionRoot, 'environment.json');
  const details = await lstatIfExists(metadataPath);
  if (details === null || !details.isFile() || details.isSymbolicLink() || details.size > 128 * 1024) throw new InterleafError('security-violation', 'The session recovery metadata is missing or unsafe.');
  const raw: PortableValue = parsePortableJson(await readFile(metadataPath, 'utf8'));
  if (!isPortableRecord(raw)) throw new InterleafError('security-violation', 'The session recovery metadata is malformed.');
  const state = parseMetadata(raw);
  if (state.sessionId !== sessionId || resolve(state.sessionRoot) !== resolve(sessionRoot) || (state.mode !== 'isolated-copy' && state.mode !== 'isolated-worktree')) throw new InterleafError('security-violation', 'The session recovery metadata is not an exact isolated environment.');
  const targetPath = await canonicalDirectory(state.targetPath);
  if (resolve(state.targetPath) !== targetPath) throw new InterleafError('security-violation', 'The session recovery target path is not canonical.');
  if (state.mode === 'isolated-copy') {
    if (state.repositoryRoot !== null || state.branchName !== null || state.baseHead !== null || state.selectedRelativePath !== '' || resolve(state.workspaceRoot) !== resolve(state.workspacePath)) throw new InterleafError('security-violation', 'The isolated-copy metadata has an unexpected Git identity.');
    await assertSessionOwnedPath(sessionRoot, state.workspacePath);
  } else {
    if (state.repositoryRoot === null || !isAgentSessionBranchName(state.branchName, sessionId) || state.baseHead === null || (state.selectedRelativePath.length > 0 && !isSafeRelativePath(state.selectedRelativePath))) throw new InterleafError('security-violation', 'The isolated-worktree metadata has an incomplete Git identity.');
    const repositoryRoot = await canonicalDirectory(state.repositoryRoot);
    if (resolve(state.repositoryRoot) !== repositoryRoot || !isPathWithin(repositoryRoot, targetPath)) throw new InterleafError('security-violation', 'The isolated-worktree metadata does not bind the selected target to its repository.');
    await assertSessionOwnedPath(sessionRoot, state.workspaceRoot);
    const expectedWorkspace = state.selectedRelativePath.length === 0 ? state.workspaceRoot : safeJoin(state.workspaceRoot, state.selectedRelativePath);
    if (resolve(state.workspacePath) !== resolve(expectedWorkspace)) throw new InterleafError('security-violation', 'The isolated-worktree metadata has an unsafe selected workspace path.');
    if (!await isRegisteredWorktree(repositoryRoot, state.workspaceRoot, runGit)) throw new InterleafError('security-violation', 'The isolated-worktree recovery metadata no longer identifies a registered worktree.');
  }
  await assertSessionOwnedPath(sessionRoot, state.workspaceRoot);
  await assertSessionOwnedPath(sessionRoot, state.baselinePath);
  return { state: { ...state, targetPath }, raw };
}

function validateBoundRecoveryMetadata(value: PortableRecord, current: ValidatedRecoveryMetadata): PortableRecord {
  const previous = parseMetadata(value);
  if (previous.sessionId !== current.state.sessionId || previous.mode !== current.state.mode || resolve(previous.sessionRoot) !== resolve(current.state.sessionRoot) || !samePath(previous.targetPath, current.state.targetPath) || !samePath(previous.workspacePath, current.state.workspacePath) || !samePath(previous.workspaceRoot, current.state.workspaceRoot) || !samePath(previous.baselinePath, current.state.baselinePath) || previous.selectedRelativePath !== current.state.selectedRelativePath || previous.branchName !== current.state.branchName || !sameNullablePath(previous.repositoryRoot, current.state.repositoryRoot) || previous.baseHead !== current.state.baseHead) throw new InterleafError('security-violation', 'The apply recovery metadata is not bound to the current session identity.');
  return value;
}

async function assertSessionOwnedPath(sessionRoot: string, candidate: string): Promise<void> {
  if (!isStrictlyInside(sessionRoot, candidate)) throw new InterleafError('security-violation', 'The session recovery metadata points outside the app-owned session root.');
  await assertNoSymlinkAncestors(sessionRoot, candidate);
  const details = await lstatIfExists(candidate);
  if (details?.isSymbolicLink() === true) throw new InterleafError('security-violation', 'The session recovery metadata points through a symbolic link.');
}

function samePath(left: string, right: string): boolean { return resolve(left) === resolve(right); }

function sameNullablePath(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : samePath(left, right);
}

/**
 * Resolves and proves every path a journal rollback will touch, without
 * mutating anything. Separating this from the restore loop is what lets the
 * whole restore set be preflighted before the first removal.
 */
async function resolveJournalRestoreItems(journal: ApplyJournal): Promise<readonly { readonly target: string; readonly backup: string | null }[]> {
  const items: { readonly target: string; readonly backup: string | null }[] = [];
  for (const item of [...journal.backups].reverse()) {
    const target = safeJoin(journal.targetPath, item.relativePath);
    await assertNoSymlinkAncestors(journal.targetPath, target);
    const current = await lstatIfExists(target);
    if (current?.isSymbolicLink() === true) throw new InterleafError('security-violation', 'Recovery encountered a symbolic-link target and stopped safely.');
    if (!item.existed) {
      items.push({ target, backup: null });
      continue;
    }
    const backupRelative = item.backupRelativePath;
    if (backupRelative === null) throw new InterleafError('security-violation', 'Recovery is missing a required backup entry.');
    const backup = safeJoin(journal.recoveryPath, backupRelative);
    await assertNoSymlinkAncestors(journal.recoveryPath, backup);
    const backupDetails = await lstatIfExists(backup);
    if (backupDetails === null || backupDetails.isSymbolicLink()) throw new InterleafError('security-violation', 'Recovery backup is missing or symbolic-linked.');
    items.push({ target, backup });
  }
  return items;
}

async function rollbackApplyJournal(journal: ApplyJournal): Promise<void> {
  if (await canonicalDirectory(journal.targetPath) !== journal.targetPath) throw new InterleafError('security-violation', 'The apply recovery target identity changed.');
  const items = await resolveJournalRestoreItems(journal);
  // Item G: the startup path has the same ordering obligation as the in-flight
  // rollback, on its own budget. Every target survives a backup set that cannot
  // be proved readable and in-bounds in full.
  const proven = await preflightRestore(journal.recoveryPath, items);
  const budget = createBackupBudget();
  for (const item of items) {
    if (item.backup === null) {
      await removeCreatedEntry(item.target, budget);
      continue;
    }
    const backupDetails = proven.get(item.backup);
    if (backupDetails === undefined) throw new InterleafError('internal', 'A recovery backup was not proved before restoration.');
    await rm(item.target, { recursive: true, force: true });
    await mkdir(dirname(item.target), { recursive: true, mode: 0o755 });
    await copyBackupEntry(item.backup, item.target, backupDetails, budget);
  }
  await removeEmptyCreatedDirectories(journal.createdDirectories.map((item) => safeJoin(journal.targetPath, item)), journal.targetPath);
  await writeManifestFile(journal.sessionRoot, journal.previousManifest);
  await writeAtomicMetadata(journal.sessionRoot, JSON.stringify(journal.previousMetadata));
  await removeOwnedDirectory(journal.stagePath, dirname(journal.targetPath));
  await removeOwnedDirectory(journal.recoveryPath, journal.sessionRoot);
}

function isSnapshotEntryType(value: PortableMember): value is SnapshotEntry['type'] {
  return value === 'file' || value === 'directory' || value === 'symlink';
}

function isValidManifest(value: PortableMember): value is Manifest {
  if (!isPortableRecord(value) || value.version !== 1 || (value.rootKind !== 'git' && value.rootKind !== 'copy' && value.rootKind !== 'active') || typeof value.createdAt !== 'string' || !isPortableArray(value.entries) || value.entries.length > MAX_TREE_ENTRIES) return false;
  return value.entries.every((entry) => isPortableRecord(entry) && typeof entry.path === 'string' && isSafeRelativePath(entry.path) && isSnapshotEntryType(entry.type) && typeof entry.mode === 'number' && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE_BYTES && (entry.type === 'directory' ? entry.hash === null && entry.size === 0 : typeof entry.hash === 'string' && /^[a-f0-9]{64}$/iu.test(entry.hash)));
}

async function removeOwnedDirectory(path: string, parent: string): Promise<void> {
  const details = await lstatIfExists(path);
  if (details === null) return;
  if (!details.isDirectory() || details.isSymbolicLink()) throw new InterleafError('security-violation', 'Refusing to remove an unsafe recovery directory.');
  await assertNoSymlinkAncestors(parent, path);
  await rm(path, { recursive: true, force: true });
}

async function canonicalDirectory(input: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(input));
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch (error) {
    throw new InterleafError('mode-resolution-failed', 'The selected target directory is inaccessible.', { cause: error instanceof Error ? error : null });
  }
}

async function isGitRepository(path: string, runGit: GitRunner = gitOutput): Promise<boolean> {
  try {
    const root = await runGit(path, ['rev-parse', '--show-toplevel']);
    const canonicalRoot = await realpath(root);
    return isPathWithin(canonicalRoot, path);
  } catch { return false; }
}

async function isDirectoryPath(path: string): Promise<boolean> {
  const details = await lstatIfExists(path);
  return details?.isDirectory() === true && !details.isSymbolicLink();
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileBounded('git', ['-C', cwd, ...args], { shell: false, encoding: 'utf8', env: buildMinimalChildEnvironment(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return result.stdout.trim();
  } catch (error) {
    throw new InterleafError('mode-resolution-failed', 'A bounded Git operation failed; isolation was not prepared.', { cause: error instanceof Error ? error : null });
  }
}

async function gitBranchExists(cwd: string, branch: string, runGit: GitRunner = gitOutput): Promise<boolean> {
  try { await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; }
}

async function isRegisteredWorktree(repositoryRoot: string, workspacePath: string, runGit: GitRunner = gitOutput): Promise<boolean> {
  try {
    const listing = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain']);
    const canonicalWorkspace = await realpath(workspacePath);
    return listing.split(/\r?\n/u).some((line) => line.startsWith('worktree ') && realpathSyncLike(line.slice('worktree '.length), canonicalWorkspace));
  } catch { return false; }
}

/**
 * Missing and malformed are different answers.
 *
 * This record is the only durable evidence that an *external* Git worktree and
 * branch were registered outside the app-owned root. Collapsing "there is no
 * record" and "the record cannot be read" into one `null` made a corrupt or
 * unreadable record mean *absence* — which is precisely the answer that lets a
 * caller recursively remove the session root and orphan the registration it
 * could no longer read about. Unreadable now retains the root and the
 * registration for explicit repair.
 */
type PendingCleanupRead =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly record: PendingGitCleanup }
  | { readonly status: 'unreadable' };

async function readPendingCleanup(sessionRoot: string): Promise<PendingCleanupRead> {
  let raw: string;
  try {
    raw = await readFile(join(sessionRoot, PENDING_CLEANUP_FILE), 'utf8');
  } catch (error) {
    // Only a genuinely absent file is absence. A permission error, an I/O
    // failure or a directory in its place is uncertainty, not "nothing here".
    const missing = isNotFound(error instanceof Error ? error : null);
    return missing ? { status: 'absent' } : { status: 'unreadable' };
  }
  try {
    const value: PortableValue = parsePortableJson(raw);
    if (!isPortableRecord(value)) return { status: 'unreadable' };
    const record = value;
    if (record.version !== 1 || typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId) || record.sessionId !== basename(sessionRoot) || typeof record.repositoryRoot !== 'string' || typeof record.worktreeRoot !== 'string' || typeof record.branchName !== 'string' || !isAgentSessionBranchName(record.branchName, record.sessionId) || typeof record.registered !== 'boolean' || typeof record.committed !== 'boolean') return { status: 'unreadable' };
    const worktreeRoot = safeJoin(sessionRoot, 'worktree');
    if (resolve(record.worktreeRoot) !== worktreeRoot) return { status: 'unreadable' };
    const repositoryRoot = await realpath(resolve(record.repositoryRoot));
    const details = await stat(repositoryRoot);
    if (!details.isDirectory() || isPathWithin(repositoryRoot, sessionRoot)) return { status: 'unreadable' };
    return { status: 'present', record: { version: 1, sessionId: record.sessionId, repositoryRoot, worktreeRoot, branchName: record.branchName, registered: record.registered, committed: record.committed } };
  } catch {
    // Corrupt or unresolved records are intentionally left untouched. The
    // caller must never turn an untrusted cleanup hint into a deletion target.
    return { status: 'unreadable' };
  }
}

async function cleanupPendingGit(pending: PendingGitCleanup, runGit: GitRunner = gitOutput): Promise<void> {
  if (await isRegisteredWorktree(pending.repositoryRoot, pending.worktreeRoot, runGit)) {
    await runGit(pending.repositoryRoot, ['worktree', 'remove', '--force', pending.worktreeRoot]);
    if (await isRegisteredWorktree(pending.repositoryRoot, pending.worktreeRoot, runGit)) throw new InterleafError('internal', 'Pending Git worktree cleanup did not remove the registration.');
  }
  if (await gitBranchExists(pending.repositoryRoot, pending.branchName, runGit)) {
    await runGit(pending.repositoryRoot, ['branch', '-D', pending.branchName]);
    if (await gitBranchExists(pending.repositoryRoot, pending.branchName, runGit)) throw new InterleafError('internal', 'Pending Git branch cleanup did not remove the session branch.');
  }
}

async function writePendingCleanup(pending: PendingGitCleanup, sessionRoot: string): Promise<void> {
  const output = safeJoin(sessionRoot, PENDING_CLEANUP_FILE);
  const temporary = safeJoin(sessionRoot, `.${PENDING_CLEANUP_FILE}.tmp`);
  // Item J: this record decides whether an external Git worktree and branch
  // get unwound after a crash, so it is made durable the same way as every
  // other preparation record — O_EXCL temp, fsync, rename, directory fsync —
  // rather than left to a partially flushed `writeFile`.
  await unlink(temporary).catch(() => undefined);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify(pending), { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, output);
  await syncDirectory(sessionRoot);
}

function realpathSyncLike(value: string, expected: string): boolean {
  try { return resolve(value) === resolve(expected); } catch { return false; }
}

async function copyBoundedDirectory(source: string, destination: string, index: GitTrackedIndex = EMPTY_TRACKED_INDEX): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let total = 0;
  let entries = 0;
  await copyTree(source, destination, source, index, (bytes) => { total += bytes; if (total > MAX_TOTAL_BYTES) throw new InterleafError('validation', 'The selected directory exceeds the bounded isolation copy limit.'); }, () => { entries += 1; if (entries > MAX_TREE_ENTRIES) throw new InterleafError('validation', 'The selected directory exceeds the bounded entry-count isolation limit.'); });
}

async function copyTree(source: string, destination: string, root: string, index: GitTrackedIndex, consume: (bytes: number) => void, consumeEntry: () => void): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relativePathBetween(root, join(source, entry.name)).split(sep).join('/');
    // Item K: the copy and the manifest must agree about what the tree is, so
    // the index governs both or neither.
    if (isGeneratedName(entry.name) && !index.generatedFiles.has(rel) && !index.generatedDirectories.has(rel)) continue;
    consumeEntry();
    // Item E: the same grammar governs the copy boundary, so a name the
    // manifest could not represent never reaches an app-owned workspace.
    assertSafeRelativePath(rel, 'an isolated directory copy');
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    const details = await lstat(src);
    if (details.isSymbolicLink()) {
      // Item L: an untracked link is still refused — it can escape the selected
      // project when an agent follows it later. A tracked, in-tree link is
      // recreated as a link; `readlink` reads the link's own target string and
      // never opens what it points at.
      if (!index.symlinks.has(rel)) throw new InterleafError('security-violation', `Symlinks are not allowed in isolated directory copies: ${rel}`);
      await symlink(await readContainedLinkTarget(root, src, rel), dst);
      continue;
    }
    if (details.isDirectory()) {
      await mkdir(dst, { recursive: true, mode: details.mode & 0o777 });
      await copyTree(src, dst, root, index, consume, consumeEntry);
    } else if (details.isFile()) {
      if (details.size > MAX_FILE_BYTES) throw new InterleafError('validation', `File exceeds the bounded isolation copy limit: ${rel}`);
      consume(details.size);
      await copyFile(src, dst);
      await chmod(dst, details.mode & 0o777);
    }
  }
}

/**
 * Item H: the walk and the hashing happen on a bounded worker; the policy that
 * decides what a manifest may contain happens here, on the result.
 *
 * The pool's authorized-root set is the fixed list of canonical roots a scan
 * may ever touch. A root is registered immediately before dispatch and revoked
 * immediately after, so the worker entry point is never a standing read
 * primitive. `options.signal` is the owning session's cancellation handle: a
 * discarded session stops the scan it queued rather than paying for it.
 */
async function snapshotDirectory(
  pool: SnapshotWorkerPool,
  root: string,
  index: GitTrackedIndex = EMPTY_TRACKED_INDEX,
  options?: SnapshotWorkerOptions,
): Promise<readonly SnapshotEntry[]> {
  const canonicalRoot = resolve(root);
  const request: SnapshotWorkerRequest = {
    root: canonicalRoot,
    generatedNames: [...GENERATED_NAMES],
    stagePrefixes: [AGENT_STAGE_DIRECTORY_PREFIX, LEGACY_AGENT_STAGE_DIRECTORY_PREFIX],
    trackedGeneratedFiles: [...index.generatedFiles],
    trackedGeneratedDirectories: [...index.generatedDirectories],
    maxEntries: MAX_TREE_ENTRIES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxLinkBytes: MAX_SYMLINK_TARGET_BYTES,
    ...snapshotRequestDefaults(),
  };
  pool.authorizeRoot(canonicalRoot);
  let records: readonly RawSnapshotRecord[];
  try {
    records = await pool.run(request, options ?? {});
  } finally {
    pool.revokeRoot(canonicalRoot);
  }

  const entries: SnapshotEntry[] = [];
  let total = 0;
  for (const record of records) {
    // Item E: accept only paths this manifest's own reader will accept, so a
    // snapshot can never record an entry that a restart silently discards.
    assertSafeRelativePath(record.path, 'an agent workspace manifest');
    // Item K, re-applied in main: a generated-looking name is admitted only
    // while the index says something under it is tracked. Ignored status is
    // not untracked status, and the worker does not get the last word.
    const name = record.path.slice(record.path.lastIndexOf('/') + 1);
    if (isGeneratedName(name) && !index.generatedFiles.has(record.path) && !index.generatedDirectories.has(record.path)) {
      throw new InterleafError('internal', 'The workspace scan returned an entry outside the tracked index answer.');
    }
    if (entries.length >= MAX_TREE_ENTRIES) throw new InterleafError('validation', 'Agent workspace exceeds bounded entry-count manifest limits.');
    if (record.kind === 'symlink') {
      // Item L: only an index-tracked link is representable, and only as
      // metadata. The worker read the link string with `readlink` and never
      // opened it; the containment decision is made here.
      if (!index.symlinks.has(record.path)) throw new InterleafError('security-violation', `Symlinks are not permitted in an agent workspace: ${record.path}`);
      const value = record.linkValue;
      assertContainedLinkValue(canonicalRoot, join(canonicalRoot, record.path), record.path, value);
      entries.push({
        path: record.path,
        type: 'symlink',
        mode: record.mode,
        size: Buffer.byteLength(value, 'utf8'),
        hash: createHash('sha256').update(value, 'utf8').digest('hex'),
      });
      continue;
    }
    if (record.kind === 'directory') {
      entries.push({ path: record.path, type: 'directory', mode: record.mode, size: 0, hash: null });
      continue;
    }
    if (record.size > MAX_FILE_BYTES || (total += record.size) > MAX_TOTAL_BYTES) {
      throw new InterleafError('validation', 'Agent workspace exceeds bounded manifest limits.');
    }
    entries.push({ path: record.path, type: 'file', mode: record.mode, size: record.size, hash: record.hash.toLowerCase() });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Bounded metadata for one tracked link: the link string, never its target. */
const MAX_SYMLINK_TARGET_BYTES = 4_096;

function assertContainedLinkValue(root: string, file: string, rel: string, value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_SYMLINK_TARGET_BYTES) {
    throw new InterleafError('security-violation', `A tracked symbolic link exceeds the bounded metadata limit: ${rel}`);
  }
  // An escaping link is refused rather than recorded. Nothing follows it here,
  // but a manifest entry is an authorization to carry it forward, and a link
  // that points outside the selected tree must never gain that status.
  if (isAbsolutePath(value) || !isPathWithin(resolve(root), resolve(dirname(file), value))) {
    throw new InterleafError('security-violation', `A tracked symbolic link escapes the agent workspace: ${rel}`);
  }
}

async function readContainedLinkTarget(root: string, file: string, rel: string): Promise<string> {
  const value = await readlink(file);
  assertContainedLinkValue(root, file, rel, value);
  return value;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => { resolvePromise(); });
  });
  return hash.digest('hex');
}

/**
 * Why Apply is unavailable, or `null` when it is offered. Ordered most general
 * first: a direct mode has nothing staged to apply at all, a dirty primary
 * worktree makes "what changed" unanswerable, and a link change (item L) can
 * only be reported, never carried across.
 */
function isGeneratedName(name: string): boolean {
  return GENERATED_NAMES.has(name) || isAgentStageDirectoryName(name);
}

function findEntry(entries: readonly SnapshotEntry[], path: string): SnapshotEntry | undefined {
  return entries.find((entry) => entry.path === path);
}

function topLevelPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].filter((candidate) => !paths.some((other) => other !== candidate && candidate.startsWith(`${other}/`)));
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

async function assertExpectedEntry(path: string, expected: SnapshotEntry | undefined): Promise<void> {
  const actual = await lstatIfExists(path);
  if (actual?.isSymbolicLink() === true) throw new InterleafError('security-violation', 'Refusing to operate through a symbolic link.');
  if (expected === undefined) {
    if (actual !== null) throw new InterleafError('security-violation', 'Destination drift was detected before the transaction boundary.');
    return;
  }
  if (actual === null || (expected.type === 'file' && !actual.isFile()) || (expected.type === 'directory' && !actual.isDirectory())) {
    throw new InterleafError('security-violation', `Destination drift was detected at ${expected.path}.`);
  }
  if ((Number(actual.mode) & 0o777) !== expected.mode) throw new InterleafError('security-violation', `Destination mode drift was detected at ${expected.path}.`);
  if (expected.type === 'file' && (Number(actual.size) !== expected.size || await hashFile(path) !== expected.hash)) {
    throw new InterleafError('security-violation', `Destination content drift was detected at ${expected.path}.`);
  }
}

async function collectMissingTargetParents(root: string, paths: readonly string[]): Promise<readonly string[]> {
  const missing = new Set<string>();
  for (const path of paths) {
    let current = dirname(safeJoin(root, path));
    while (isPathWithin(root, current) && resolve(current) !== resolve(root)) {
      if (await lstatIfExists(current) === null) missing.add(current);
      current = dirname(current);
    }
  }
  return [...missing].sort((left, right) => right.split(sep).length - left.split(sep).length);
}

async function ensureTargetParentDirectories(root: string, targetDirectory: string, workspaceEntries: readonly SnapshotEntry[]): Promise<void> {
  const base = resolve(root);
  const target = resolve(targetDirectory);
  const rel = relativePathWithin(base, target);
  if (rel === null || rel === '') return;
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    await assertNoSymlinkAncestors(base, current);
    const existing = await lstatIfExists(current);
    if (existing !== null) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new InterleafError('security-violation', 'A destination parent is not a safe directory.');
      continue;
    }
    const entry = workspaceEntries.find((candidate) => candidate.path === relativePathBetween(base, current).split(sep).join('/'));
    const mode = entry?.type === 'directory' ? entry.mode : 0o755;
    await mkdir(current, { recursive: false, mode });
    // mkdir is subject to the process umask; enforce the workspace manifest
    // mode after creation, including parents implicitly made for a file.
    await chmod(current, mode);
  }
}

async function removeEmptyCreatedDirectories(paths: readonly string[], root: string): Promise<void> {
  for (const path of [...paths].sort((left, right) => right.split(sep).length - left.split(sep).length)) {
    await assertNoSymlinkAncestors(root, path);
    const details = await lstatIfExists(path);
    if (details === null) continue;
    if (!details.isDirectory()) throw new InterleafError('internal', 'Recovery found a non-directory at a transaction-created parent.');
    if ((await readdir(path)).length > 0) throw new InterleafError('internal', 'Recovery could not remove a non-empty transaction-created parent.');
    // `rm` with `recursive: false` refuses a directory outright on some
    // platforms, which turned this cleanup into a rollback failure.
    await rmdir(path);
  }
}

function sameManifestEntries(a: readonly SnapshotEntry[], b: readonly SnapshotEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return right?.path === left.path && right.type === left.type && right.mode === left.mode && right.size === left.size && right.hash === left.hash;
  });
}

async function renderBoundedPatch(state: EnvironmentState, changes: readonly EnvironmentFileChange[]): Promise<string> {
  if (state.mode === 'isolated-worktree' && state.repositoryRoot !== null && state.baseHead !== null) {
    const selected = relativePathBetween(state.workspaceRoot, state.workspacePath).split(sep).filter(Boolean).join('/');
    const args = ['diff', '--binary', '--no-ext-diff', state.baseHead, '--', selected.length === 0 ? '.' : selected];
    const gitPatch = await gitPatchOutput(state.workspaceRoot, args);
    const trackedNames = new Set((await gitOutput(state.workspaceRoot, ['diff', '--name-only', state.baseHead, '--', selected.length === 0 ? '.' : selected])).split(/\r?\n/u).filter(Boolean));
    const chunks = [gitPatch];
    for (const change of changes) {
      const path = selected.length === 0 ? change.path : `${selected}/${change.path}`;
      if (trackedNames.has(path) || trackedNames.has(change.path)) continue;
      chunks.push(await renderCopyChange(state, change));
    }
    const output = chunks.join('');
    if (Buffer.byteLength(output, 'utf8') > MAX_PATCH_BYTES) throw new InterleafError('validation', `The generated patch exceeds the bounded ${String(MAX_PATCH_BYTES)}-byte limit.`);
    return output;
  }
  const chunks: string[] = [];
  for (const change of changes) {
    chunks.push(await renderCopyChange(state, change));
    if (Buffer.byteLength(chunks.join(''), 'utf8') > MAX_PATCH_BYTES) throw new InterleafError('validation', `The generated patch exceeds the bounded ${String(MAX_PATCH_BYTES)}-byte limit.`);
  }
  return chunks.join('');
}

async function renderCopyChange(state: EnvironmentState, change: EnvironmentFileChange): Promise<string> {
  const source = change.kind === 'deleted' ? null : safeJoin(state.workspacePath, change.path);
  const target = change.kind === 'created' ? null : safeJoin(state.baselinePath, change.path);
  const beforeDetails = target === null ? null : await lstatIfExists(target);
  const afterDetails = source === null ? null : await lstatIfExists(source);
  if (beforeDetails?.isDirectory() === true && afterDetails?.isDirectory() === true) {
    return `diff --git a/${change.path} b/${change.path}\nold mode ${formatMode(beforeDetails.mode, true)}\nnew mode ${formatMode(afterDetails.mode, true)}\n`;
  }
  if (beforeDetails?.isFile() === true && afterDetails?.isFile() === true && target !== null && source !== null && (Number(beforeDetails.mode) & 0o777) !== (Number(afterDetails.mode) & 0o777) && await hashFile(target) === await hashFile(source)) {
    return `diff --git a/${change.path} b/${change.path}\nold mode ${formatMode(beforeDetails.mode)}\nnew mode ${formatMode(afterDetails.mode)}\n`;
  }
  const before = target === null ? '' : await boundedText(target);
  const after = source === null ? '' : await boundedText(source);
  const binary = before.startsWith('[binary') || after.startsWith('[binary');
  const modeLine = copyModeLine(change.kind, beforeDetails, afterDetails);
  return `diff --git a/${change.path} b/${change.path}\n${modeLine}--- ${change.kind === 'created' ? '/dev/null' : `a/${change.path}`}\n+++ ${change.kind === 'deleted' ? '/dev/null' : `b/${change.path}`}\n${binary ? `Binary files ${change.kind === 'created' ? '/dev/null' : `a/${change.path}`} and ${change.kind === 'deleted' ? '/dev/null' : `b/${change.path}`} differ\n` : simpleUnifiedDiff(before, after)}`;
}

type LstatResult = Awaited<ReturnType<typeof lstatIfExists>>;

function copyModeLine(kind: EnvironmentFileChange['kind'], before: LstatResult, after: LstatResult): string {
  if (kind === 'created' && after !== null) return `new file mode ${formatMode(after.mode)}\n`;
  if (kind === 'deleted' && before !== null) return `deleted file mode ${formatMode(before.mode)}\n`;
  return '';
}

async function gitPatchOutput(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileBounded('git', ['-C', cwd, ...args], { shell: false, encoding: 'utf8', env: buildMinimalChildEnvironment(), timeout: 15_000, maxBuffer: MAX_PATCH_BYTES + 1, windowsHide: true });
    const output = result.stdout;
    if (Buffer.byteLength(output, 'utf8') > MAX_PATCH_BYTES) throw new InterleafError('validation', `The generated Git patch exceeds the bounded ${String(MAX_PATCH_BYTES)}-byte limit.`);
    return output;
  } catch (error) {
    if (error instanceof InterleafError) throw error;
    throw new InterleafError('validation', 'The bounded Git patch could not be generated.', { cause: error instanceof Error ? error : null });
  }
}

function safeJoin(root: string, child: string): string {
  const base = resolve(root);
  const candidate = resolve(base, normalize(child));
  if (relativePathWithin(base, candidate) === null) throw new InterleafError('security-violation', 'Path escapes the app-owned environment.');
  if (candidate === base && child.length > 0) throw new InterleafError('security-violation', 'Path resolves to an environment root.');
  return candidate;
}

async function lstatIfExists(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); } catch (error) {
    // A missing entry and a non-directory on the way to it both mean "not there".
    const code = error instanceof Error ? errnoCode(error) : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** A missing entry, or a non-directory on the way to it: the path is not there. */
function isNotFound(error: Error | null): boolean {
  const code = error === null ? null : errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Runs a rollback step and answers with the error it failed on, if any. */
async function failureOf<T>(step: () => Promise<T>): Promise<Error | null> {
  try {
    await step();
    return null;
  } catch (error) {
    return toError(error instanceof Error ? error : null);
  }
}

async function assertNoSymlinkAncestors(root: string, candidate: string): Promise<void> {
  const base = resolve(root);
  const target = resolve(candidate);
  const baseDetails = await lstatIfExists(base);
  if (baseDetails?.isSymbolicLink() === true || baseDetails?.isDirectory() !== true) throw new InterleafError('security-violation', 'Refusing to operate through an unsafe environment root.');
  const rel = relativePathWithin(base, target);
  if (rel === null) throw new InterleafError('security-violation', 'Path escapes its permitted environment.');
  let current = base;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    const details = await lstatIfExists(current);
    if (details?.isSymbolicLink() === true) throw new InterleafError('security-violation', 'Refusing to traverse a symbolic-link parent.');
  }
}


function isAbsolutePath(path: string): boolean { return path.startsWith(sep) || /^[A-Za-z]:[\\/]/u.test(path); }

/**
 * Fail-closed proof that the journaled target is still the same directory.
 * The recorded canonical path and file identity must all match the
 * filesystem right now; a replacement, remount, or symlink swap — including a
 * recreated directory with identical content — is rejected without touching
 * the target or the session's terminal state.
 */
async function assertJournaledTargetIdentity(state: EnvironmentState): Promise<void> {
  // Fail closed: a journal without a provable file identity cannot prove
  // that the directory in front of us is the one the session was authorized
  // against. Pre-identity journals (and corrupted ones) are therefore not
  // resumable, reviewable, appliable, or openable. Startup cleanup leaves such
  // an environment on disk untouched rather than re-admitting it.
  if (state.targetIdentity === null || !hasProvableIdentity(state.targetIdentity)) {
    throw new InterleafError('security-violation', 'This agent environment has no durable target identity and cannot be continued.');
  }
  const proof = await proveDirectoryIdentity(state.targetPath, state.targetIdentity);
  if (proof.kind === 'inaccessible') {
    throw new InterleafError('security-violation', 'The recorded agent target is no longer accessible; this session cannot continue.', { cause: proof.cause });
  }
  if (proof.kind === 'replaced') {
    throw new InterleafError('security-violation', 'The recorded agent target directory was replaced; this session cannot continue.');
  }
}

function parseMetadata(value: PortableValue): EnvironmentState {
  if (!isPortableRecord(value)) throw new Error('invalid metadata');
  const record = value;
  if (typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId) || typeof record.mode !== 'string' || typeof record.targetPath !== 'string' || typeof record.workspacePath !== 'string' || typeof record.sessionRoot !== 'string') throw new Error('invalid metadata');
  return {
    sessionId: record.sessionId,
    mode: record.mode as ResolvedAgentExecutionMode,
    targetPath: record.targetPath,
    targetIdentity: parseFileIdentity(record.targetIdentity),
    workspacePath: record.workspacePath,
    workspaceRoot: typeof record.workspaceRoot === 'string' ? record.workspaceRoot : record.workspacePath,
    selectedRelativePath: typeof record.selectedRelativePath === 'string' ? record.selectedRelativePath : '',
    baselinePath: typeof record.baselinePath === 'string' ? record.baselinePath : record.workspacePath,
    sessionRoot: record.sessionRoot,
    manifest: { version: 1, rootKind: 'copy', entries: [], createdAt: new Date(0).toISOString() },
    primaryWasDirty: record.primaryWasDirty === true,
    branchName: typeof record.branchName === 'string' ? record.branchName : null,
    repositoryRoot: typeof record.repositoryRoot === 'string' ? record.repositoryRoot : null,
    baseHead: typeof record.baseHead === 'string' ? record.baseHead : null,
    containerRuntime: record.containerRuntime === 'docker' || record.containerRuntime === 'podman' ? record.containerRuntime : null,
    dangerousProfile: record.dangerousProfile === true,
    lockKey: typeof record.lockKey === 'string' ? record.lockKey : record.sessionId,
    lockScope: typeof record.lockScope === 'string' ? record.lockScope : record.targetPath,
    trackedIndex: EMPTY_TRACKED_INDEX,
    indexFrozen: record.indexVersion === 1,
    tests: [], suppressedTests: 0, runAdmitted: 0, runSuppressed: 0, runSummaryIndex: null, testsDirty: false,
    released: false, applied: record.applied === true,
  };
}

async function writeTrackedIndex(sessionRoot: string, index: GitTrackedIndex, afterTempWrite?: () => Promise<void>): Promise<void> {
  await writeAtomicSessionFile(TRACKED_INDEX_RECORD, sessionRoot, serializeTrackedIndex(index), afterTempWrite);
}

/**
 * Reads the session's frozen index answer.
 *
 * `frozen` says whether this session's own metadata claims to have written one.
 * A session recorded with `indexVersion: 1` wrote `tracked-index.json` before
 * its metadata existed, so a missing file there is a lost or truncated record,
 * not a legacy session — treating it as "nothing tracked" would silently
 * redefine the baseline as name-only and drop every tracked `dist/` path and
 * tracked link from review, apply and patch export. Only an environment with no
 * such claim, which genuinely predates this record, is read as an empty index.
 * Malformed, oversized or unsafe always fails closed.
 */
async function readTrackedIndex(sessionRoot: string, frozen: boolean): Promise<GitTrackedIndex> {
  const path = safeJoin(sessionRoot, TRACKED_INDEX_RECORD.fileName);
  const details = await lstatIfExists(path);
  if (details === null) {
    if (frozen) throw new InterleafError('security-violation', 'The Git tracked-index record this environment was frozen with is missing.');
    return EMPTY_TRACKED_INDEX;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size > TRACKED_INDEX_RECORD.maxBytes) {
    throw new InterleafError('security-violation', 'The Git tracked-index record is unsafe or exceeds the bounded limit.');
  }
  const parsed = parseTrackedIndex(parsePortableJson(await readFile(path, 'utf8')));
  if (parsed === null) throw new InterleafError('security-violation', 'The Git tracked-index record is malformed.');
  return parsed;
}

async function readManifest(sessionRoot: string): Promise<Manifest | null> {
  try {
    const value: PortableValue = parsePortableJson(await readFile(join(sessionRoot, MANIFEST_RECORD.fileName), 'utf8'));
    if (!isPortableRecord(value) || !isPortableArray(value.entries)) return null;
    const recordValue: PortableRecord = value;
    const rawEntries: readonly PortableValue[] = value.entries;
    if (rawEntries.length > MAX_TREE_ENTRIES) return null;
    const entries = rawEntries.filter((entry: PortableValue): entry is SnapshotEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      const record = entry as PortableRecord;
      // Item E: segment-aware, so an ordinary `foo..bar` survives a restart
      // while every real traversal, absolute, drive, UNC, NUL, empty and dot
      // segment form is still refused.
      return typeof record.path === 'string' && isSafeRelativePath(record.path) && isSnapshotEntryType(record.type) && typeof record.mode === 'number' && Number.isInteger(record.mode) && record.mode >= 0 && record.mode <= 0o777 && typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0 && record.size <= MAX_FILE_BYTES && (record.type === 'directory' ? record.hash === null && record.size === 0 : typeof record.hash === 'string' && /^[a-f0-9]{64}$/iu.test(record.hash));
    });
    if (entries.length !== rawEntries.length) return null;
    return { version: 1, rootKind: recordValue.rootKind === 'git' || recordValue.rootKind === 'active' ? recordValue.rootKind : 'copy', entries, createdAt: typeof recordValue.createdAt === 'string' ? recordValue.createdAt : new Date(0).toISOString() };
  } catch { return null; }
}
