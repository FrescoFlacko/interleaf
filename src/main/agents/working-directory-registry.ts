import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { type FileIdentity, pickFileIdentity, requireProvableIdentity, sameFileIdentity, statWithIdentity } from '../security/file-identity';
import { ProtectedRootPolicy } from './protected-roots';

export type RegisteredWorkingDirectory = FileIdentity & {
  readonly handle: string;
  readonly canonicalPath: string;
};

/**
 * Main-owned durable capability record lookup.
 *
 * The registry cache is process-local and deliberately fail-closed, so a single
 * transient filesystem error evicts an entry. The durable row in
 * `allowed_working_directories` remains the authoritative record main already
 * validated, so the registry must be able to re-read it instead of treating an
 * evicted-but-still-persisted capability as permanently expired.
 */
export type DurableWorkingDirectoryLookup = (handle: string) => RegisteredWorkingDirectory | null;

/**
 * Main-owned opaque directory registry. Renderer payloads carry only handles.
 *
 * Deduplication & Identity Invariants:
 * 1. Durable Handle Stability: A canonical filesystem path maps to a single durable handle
 *    across restarts and repeated selections, preserving foreign key integrity in SQLite
 *    (`agent_sessions.target_directory_handle` and `agent_profiles.default_directory_handle`)
 *    and respecting the `allowed_working_directories.canonical_path UNIQUE` constraint.
 * 2. Explicit Capability Revalidation: Native user selection via `register()` acts as an
 *    authoritative revalidation. If the directory's identity changed on disk (e.g. recreated
 *    or remounted), `register()` safely updates the existing handle's identity.
 * 3. Fail-Closed Stale Invalidation: `resolve()` verifies current identity (device, inode, and birth
 *    time; see `../security/file-identity`) and canonical path
 *    immediately before use. If identity drift occurs, `resolve()` evicts the active entry and
 *    fails closed. An unselected stale handle never silently revives without explicit native re-selection.
 * 4. Durable Recovery Without Trust Relaxation: eviction only clears the process-local cache. When a
 *    handle is missing from the cache, `resolve()` re-reads the durable main-owned row and applies the
 *    exact same identity verification before restoring it. A handle with no durable row, a revoked
 *    handle, or a row whose identity no longer matches the filesystem still fails closed.
 * 5. Protected Application-Data Roots: a candidate that equals, contains, or lives inside one of
 *    Interleaf's own storage roots is rejected at registration and again at every resolve, so a
 *    previously persisted handle cannot become an overlapping target after the app layout changes.
 */
export class WorkingDirectoryRegistry {
  private readonly directories = new Map<string, RegisteredWorkingDirectory>();
  private readonly handlesByCanonicalPath = new Map<string, string>();
  /** Handles explicitly withdrawn by main; never revived from the durable row. */
  private readonly revokedHandles = new Set<string>();
  private loadDurable: DurableWorkingDirectoryLookup | null = null;
  private readonly protectedRoots: ProtectedRootPolicy;

  /**
   * `protectedRoots` is main-owned and supplied by the application bootstrap
   * (`src/main/index.ts`). Tests that omit it exercise the registry with no
   * declared application-data roots; production always declares them.
   */
  constructor(options: { readonly protectedRoots?: ProtectedRootPolicy } = {}) {
    this.protectedRoots = options.protectedRoots ?? new ProtectedRootPolicy();
  }

  /**
   * How many capabilities are currently held.
   *
   * Minting is the security-relevant step this class owns, and whether a
   * rejected registration minted anything is not visible from the outside: a
   * handle that was never returned cannot be resolved or revoked by a caller.
   * A read-only count is the narrowest way for a registration test to state
   * that; it exposes no handle, no path and nothing mutable.
   */
  protected get capabilityCount(): number {
    return this.directories.size;
  }

  /** Rehydrates only rows previously validated and owned by main. Builds reverse lookup. */
  rehydrate(entries: readonly RegisteredWorkingDirectory[]): void {
    for (const entry of entries) {
      if (this.revokedHandles.has(entry.handle)) continue;
      this.directories.set(entry.handle, entry);
      this.handlesByCanonicalPath.set(entry.canonicalPath, entry.handle);
    }
  }

  /**
   * Installs the main-owned durable capability source. Only the owning service
   * may supply it, and the record it returns is still fully revalidated against
   * the filesystem by `resolve()` before it is trusted.
   */
  useDurableSource(load: DurableWorkingDirectoryLookup): void {
    this.loadDurable = load;
  }

  async register(targetPath: string): Promise<{ readonly handle: string; readonly displayName: string }> {
    try {
      const canonicalPath = await realpath(resolve(targetPath));
      const { stats, identity } = await statWithIdentity(canonicalPath);
      if (!stats.isDirectory()) {
        throw new InterleafError('mode-resolution-failed', 'The selected target is not a directory.');
      }
      requireProvableIdentity(identity, () => new InterleafError('mode-resolution-failed', 'The selected folder is on a filesystem that does not report creation times, so Interleaf cannot later prove it was not replaced. Choose a folder on a different drive.'));
      // Rejected before any handle is minted or persisted, so an overlapping
      // selection never becomes a capability another subsystem can resolve.
      await this.protectedRoots.assertSelectable(canonicalPath);
      const handle = this.reuseOrMintHandle(canonicalPath);
      const entry: RegisteredWorkingDirectory = { handle, canonicalPath, ...identity };
      this.directories.set(handle, entry);
      this.handlesByCanonicalPath.set(canonicalPath, handle);
      return {
        handle,
        displayName: canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'Selected folder',
      };
    } catch (error) {
      if (error instanceof InterleafError) {
        throw error;
      }
      throw new InterleafError('mode-resolution-failed', 'The selected target directory is inaccessible.', {
        cause: error instanceof Error ? error : null,
      });
    }
  }

  /**
   * The durable handle this canonical path already owns, or a fresh one.
   *
   * Reuse keeps invariant 1: a path maps to one handle across restarts and
   * repeated selections. A revoked handle is never revived by reuse.
   */
  private reuseOrMintHandle(canonicalPath: string): string {
    const mapped = this.handlesByCanonicalPath.get(canonicalPath);
    if (mapped === undefined || this.revokedHandles.has(mapped)) return randomUUID();
    return mapped;
  }

  async resolve(handle: string): Promise<RegisteredWorkingDirectory> {
    const registered = this.recallCapability(handle);
    if (registered === undefined) {
      throw new InterleafError('mode-resolution-failed', 'The working-directory handle is invalid or expired.');
    }
    try {
      const [canonicalPath, current] = await Promise.all([
        realpath(registered.canonicalPath),
        statWithIdentity(registered.canonicalPath),
      ]);
      if (!stillTheSameDirectory(canonicalPath, current, registered)) {
        this.directories.delete(handle);
        throw new InterleafError(
          'mode-resolution-failed',
          'The registered working directory changed and must be selected again.'
        );
      }
      // Re-checked on every use: the protected-root set is fixed, but the
      // filesystem underneath a persisted handle is not.
      await this.protectedRoots.assertSelectable(registered.canonicalPath);
      // Only a verified identity is (re)admitted to the process-local cache.
      this.directories.set(handle, registered);
      this.handlesByCanonicalPath.set(registered.canonicalPath, handle);
      return registered;
    } catch (error) {
      this.directories.delete(handle);
      if (error instanceof InterleafError) {
        throw error;
      }
      throw new InterleafError(
        'mode-resolution-failed',
        'The registered working directory is no longer accessible.',
        { cause: error instanceof Error ? error : null }
      );
    }
  }

  /**
   * Returns the capability record to verify, preferring the process-local cache
   * and falling back to the durable main-owned row. The record is a claim only:
   * the caller must still revalidate it against the filesystem.
   */
  private recallCapability(handle: string): RegisteredWorkingDirectory | undefined {
    if (this.revokedHandles.has(handle)) return undefined;
    const cached = this.directories.get(handle);
    if (cached !== undefined) return cached;
    const durable = this.loadDurable?.(handle) ?? undefined;
    if (durable?.handle !== handle) return undefined;
    return { handle: durable.handle, canonicalPath: durable.canonicalPath, ...pickFileIdentity(durable) };
  }

  revoke(handle: string): boolean {
    const entry = this.directories.get(handle);
    const deleted = this.directories.delete(handle);
    this.revokedHandles.add(handle);
    if (entry !== undefined) {
      this.handlesByCanonicalPath.delete(entry.canonicalPath);
    } else {
      for (const [canonicalPath, mappedHandle] of this.handlesByCanonicalPath.entries()) {
        if (mappedHandle === handle) {
          this.handlesByCanonicalPath.delete(canonicalPath);
        }
      }
    }
    return deleted;
  }

  clear(): void {
    this.directories.clear();
    this.handlesByCanonicalPath.clear();
    this.revokedHandles.clear();
    this.loadDurable = null;
  }
}

/**
 * True while the entry on disk is still the exact directory the capability was
 * minted for: same canonical path and the same file identity.
 */
function stillTheSameDirectory(
  canonicalPath: string,
  current: { readonly stats: BigIntStats; readonly identity: FileIdentity },
  registered: RegisteredWorkingDirectory,
): boolean {
  return current.stats.isDirectory()
    && canonicalPath === registered.canonicalPath
    && sameFileIdentity(registered, current.identity);
}
