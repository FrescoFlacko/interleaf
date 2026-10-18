import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { executableIdentitySchema, type ExecutableIdentity } from '@shared/schemas/custom-agent-profile';
import { hashFileInWorker } from '../workers/hash-file-worker';
import { isPathWithin } from '../security/path-guard';
import { fileIdentityFromStats, requireProvableIdentity, sameFileIdentity } from '../security/file-identity';

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const WINDOWS_EXECUTABLE_EXTENSIONS: Record<string, true> = { '.exe': true, '.com': true };

const KNOWN_SHELL_BASENAMES: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  csh: true,
  tcsh: true,
  fish: true,
  pwsh: true,
  'pwsh.exe': true,
  powershell: true,
  'powershell.exe': true,
  cmd: true,
  'cmd.exe': true,
  wsl: true,
  'wsl.exe': true,
};

const POSIX_SHELL_BASENAMES: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  csh: true,
  tcsh: true,
  fish: true,
};

const POWERSHELL_SHELL_BASENAMES: Record<string, true> = {
  pwsh: true,
  'pwsh.exe': true,
  powershell: true,
  'powershell.exe': true,
};

const CMD_SHELL_BASENAMES: Record<string, true> = {
  cmd: true,
  'cmd.exe': true,
};

function extractExecutableBasename(filePath: string): string {
  const parts = filePath.split(/[/\\]+/u);
  return (parts.at(-1) ?? filePath).toLowerCase();
}

export function validateShellExecutable(
  canonicalPath: string,
  family: 'posix' | 'powershell' | 'cmd',
  platform: string = process.platform,
): void {
  const name = extractExecutableBasename(canonicalPath);
  if (family === 'posix') {
    if (platform === 'win32') {
      throw new InterleafError('security-violation', 'POSIX shell family is not supported on Windows.');
    }
    if (POSIX_SHELL_BASENAMES[name] !== true) {
      throw new InterleafError('security-violation', `The selected executable "${name}" is not an allowed POSIX shell binary.`);
    }
  } else if (family === 'powershell') {
    if (POWERSHELL_SHELL_BASENAMES[name] !== true) {
      throw new InterleafError('security-violation', `The selected executable "${name}" is not an allowed PowerShell binary.`);
    }
  } else {
    if (platform !== 'win32') {
      throw new InterleafError('security-violation', 'CMD shell family is only supported on Windows.');
    }
    if (CMD_SHELL_BASENAMES[name] !== true) {
      throw new InterleafError('security-violation', `The selected executable "${name}" is not an allowed CMD shell binary.`);
    }
  }
}

export function isKnownShellBinary(canonicalPath: string): boolean {
  const name = extractExecutableBasename(canonicalPath);
  return KNOWN_SHELL_BASENAMES[name] === true;
}

export type RegisteredExecutable = {
  readonly handle: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly identity: ExecutableIdentity;
};

export type PublicExecutableSelection = {
  readonly handle: string;
  readonly displayName: string;
  readonly fingerprint: string;
};

/**
 * Main-owned capability registry for executable files. A renderer can only
 * retain the opaque handle returned by register(); it cannot turn a path into
 * a capability or cause this map to contain an unvalidated target. The source
 * is revalidated immediately before every spawn; preserving the original
 * executable location (rather than copying bytes) retains wrapper/sidecar and
 * platform metadata semantics. A narrow same-user replacement race remains
 * between final validation and OS spawn and is documented as residual risk.
 */
export class ExecutableRegistry {
  private readonly executables = new Map<string, RegisteredExecutable>();

  async register(selectedPath: string): Promise<RegisteredExecutable> {
    const record = await validateExecutablePath(selectedPath);
    const handle = randomUUID();
    const registered = { ...record, handle };
    this.executables.set(handle, registered);
    return registered;
  }

  /** Rehydrates a persisted profile only when its path still has the exact identity. */
  async rehydrate(selectedPath: string, expectedIdentity: ExecutableIdentity): Promise<RegisteredExecutable> {
    const record = await validateExecutablePath(selectedPath);
    if (!sameIdentity(record.identity, expectedIdentity)) {
      throw new InterleafError('security-violation', 'The configured executable changed and must be selected again.');
    }
    const handle = randomUUID();
    const registered = { ...record, handle };
    this.executables.set(handle, registered);
    return registered;
  }

  async resolve(handle: string): Promise<RegisteredExecutable> {
    const record = this.executables.get(handle);
    if (record === undefined) throw new InterleafError('validation', 'The executable selection is invalid or expired.');
    let current: Omit<RegisteredExecutable, 'handle'>;
    try {
      current = await validateExecutablePath(record.canonicalPath);
    } catch (error) {
      // A failed integrity check revokes the opaque capability. Retaining it
      // would permit repeated attempts against an inaccessible or changing
      // source and would weaken fail-closed behavior after worker failure.
      this.revoke(handle);
      throw error;
    }
    if (!sameIdentity(current.identity, record.identity)) {
      this.revoke(handle);
      throw new InterleafError('security-violation', 'The selected executable changed and execution was stopped.');
    }
    return record;
  }

  /**
   * Synchronous because adapter.start/resume are deliberately non-async spawn
   * boundaries. This guard only performs bounded metadata and canonical-path
   * checks; content hashing happens in resolveForSpawn before the adapter is
   * entered. Keeping the sync path hash-free prevents a large executable from
   * blocking Electron's main thread.
   */
  resolveSync(handle: string): RegisteredExecutable {
    const record = this.executables.get(handle);
    if (record === undefined) throw new InterleafError('validation', 'The executable selection is invalid or expired.');
    let current: ReturnType<typeof inspectExecutablePath>;
    try {
      current = inspectExecutablePath(record.canonicalPath);
    } catch (error) {
      this.revoke(handle);
      throw error;
    }
    if (!sameMetadata(current.identity, record.identity)) {
      this.revoke(handle);
      throw new InterleafError('security-violation', 'The selected executable changed and execution was stopped.');
    }
    return record;
  }

  /**
   * Full integrity verification for selection/rehydration and the final
   * asynchronous pre-spawn check. The worker opens the file with no-follow
   * semantics and verifies metadata before and after streaming the digest.
   */
  async resolveForSpawn(handle: string): Promise<RegisteredExecutable> {
    return this.resolve(handle);
  }

  revoke(handle: string): boolean {
    return this.executables.delete(handle);
  }
  clear(): void { this.executables.clear(); }

  toPublic(record: RegisteredExecutable): PublicExecutableSelection {
    return { handle: record.handle, displayName: record.displayName, fingerprint: record.identity.sha256 };
  }
}

async function validateExecutablePath(selectedPath: string): Promise<Omit<RegisteredExecutable, 'handle'>> {
  const inspected = inspectExecutablePath(selectedPath);
  let sha256: string;
  try {
    sha256 = await hashFileInWorker(inspected.canonicalPath, {
      device: inspected.identity.device,
      inode: inspected.identity.inode,
      fileSize: inspected.identity.size,
      fileMtimeMs: Math.round(inspected.identity.mtimeMs),
    }, { label: 'executable' });
  } catch (error) {
    if (error instanceof InterleafError) throw error;
    throw new InterleafError('internal', 'The selected executable could not be verified safely.', { cause: error instanceof Error ? error : null });
  }
  const identity = executableIdentitySchema.parse({
    ...inspected.identity,
    sha256,
  });
  return { ...inspected, identity };
}

type InspectedExecutable = {
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly identity: Omit<ExecutableIdentity, 'sha256'> & { readonly sha256?: never };
};

function inspectExecutablePath(selectedPath: string): InspectedExecutable {
  if (typeof selectedPath !== 'string' || selectedPath.length === 0 || selectedPath.length > 4_096 || selectedPath.includes('\0')) {
    throw new InterleafError('validation', 'The selected executable path is invalid.');
  }
  const initial = statSelectedPath(selectedPath);
  if (initial.isSymbolicLink()) throw new InterleafError('security-violation', 'Symlinked executables are not allowed.');
  if (!initial.isFile()) throw new InterleafError('validation', 'The selected executable must be a regular file.');

  const canonicalPath = canonicalizeSelectedPath(selectedPath);
  // Re-check after realpath to close the selection-time symlink race.
  const canonicalStat = lstatSync(canonicalPath, { bigint: true });
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile()) throw new InterleafError('security-violation', 'The selected executable is not a stable regular file.');
  if (!isExecutableOnPlatform(canonicalPath, Number(canonicalStat.mode))) {
    throw new InterleafError('validation', 'The selected file is not executable on this platform.');
  }
  if (canonicalStat.size > BigInt(MAX_EXECUTABLE_BYTES)) throw new InterleafError('validation', 'The selected executable exceeds the safe size limit.');
  const fileIdentity = requireProvableIdentity(fileIdentityFromStats(canonicalStat), () => new InterleafError(
    'validation', 'The selected executable is on a filesystem that does not report creation times, so Interleaf cannot prove it is not later replaced.'));
  const identity = {
    ...fileIdentity,
    size: Number(canonicalStat.size),
    mtimeMs: millisecondsFromNanoseconds(canonicalStat.mtimeNs),
  } as const;
  return {
    canonicalPath,
    displayName: canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'Selected executable',
    identity,
  };
}

/**
 * The same value `Stats.mtimeMs` reports — whole seconds and the nanosecond
 * remainder combined as doubles — so the hash worker's own number-valued
 * `stat` agrees with it.
 */
function millisecondsFromNanoseconds(ns: bigint): number {
  return Number(ns / 1_000_000_000n) * 1_000 + Number(ns % 1_000_000_000n) / 1_000_000;
}

/** The selection's own directory entry, before any symlink is followed. */
function statSelectedPath(selectedPath: string): BigIntStats {
  try {
    return lstatSync(resolve(selectedPath), { bigint: true });
  } catch (error) {
    throw new InterleafError('validation', 'The selected executable is inaccessible.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

/** The selection with every symlink resolved, so the race re-check has a target. */
function canonicalizeSelectedPath(selectedPath: string): string {
  try {
    return realpathSync(resolve(selectedPath));
  } catch (error) {
    throw new InterleafError('validation', 'The selected executable could not be canonicalized.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

function isExecutableOnPlatform(path: string, mode: number): boolean {
  if (process.platform === 'win32') {
    const dot = path.lastIndexOf('.');
    const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
    return WINDOWS_EXECUTABLE_EXTENSIONS[extension] === true;
  }
  return (mode & 0o111) !== 0;
}

function sameIdentity(left: ExecutableIdentity, right: ExecutableIdentity): boolean {
  return sameFileIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256;
}

function sameMetadata(left: Omit<ExecutableIdentity, 'sha256'>, right: ExecutableIdentity): boolean {
  return sameFileIdentity(left, right) && left.size === right.size && Math.round(left.mtimeMs) === Math.round(right.mtimeMs);
}

/** Used by tests and diagnostics without revealing a path to the renderer. */
export function isContainedExecutablePath(path: string, root: string): boolean {
  return isPathWithin(root, path);
}
