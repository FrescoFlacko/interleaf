import type { ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import { type PortableMember, type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';
import { type FileIdentity, parseFileIdentity, proveDirectoryIdentity, sameFileIdentity } from '../security/file-identity';

/**
 * Durable, main-only session records written once at session start (schema
 * migration 24) and enforced at every privileged continuation.
 *
 * Neither record is ever projected through `mapSession`, so no canonical path,
 * file identity, executable fingerprint, or permission policy reaches the
 * renderer. Both are validated on read; anything missing, malformed, or
 * unparseable is treated as absent and fails the caller closed. A target
 * identity recorded before birth time existed (migration 26) reads back with
 * `birthtimeNs: null`, which never proves anything, so such a session stays
 * listable but every privileged continuation fails closed.
 */

/** Exact canonical target identity as proven when the session was created. */
export type PersistedTargetIdentity = FileIdentity & {
  readonly version: 1;
  readonly directoryHandle: string;
  readonly canonicalPath: string;
};

/**
 * The effective permission policy and authority snapshot resolved by main for
 * this session. Resume enforces this record rather than the profile's current
 * defaults, so a later settings edit cannot widen an existing session.
 */
export type PersistedSessionAuthority = {
  readonly version: 1;
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly effectivePermissionPolicy: string;
  readonly executionMode: ResolvedAgentExecutionMode;
  readonly unsafeProfile: boolean;
  /** Exact native-sandbox argv tokens; empty unless the mode is native-restricted. */
  readonly sandboxArgs: readonly string[];
  /** Exact reasoning-effort value recorded at start; reused verbatim on resume. */
  readonly reasoningEffort: string | null;
  /** Proof binding for native-restricted; `null` for every other mode. */
  readonly nativeCapability: {
    readonly contractId: string;
    readonly executableFingerprint: string;
  } | null;
};

const EXECUTION_MODES = new Set<string>([
  'isolated-worktree', 'isolated-copy', 'native-restricted', 'active-env', 'container-sandbox',
]);

export function serializeTargetIdentity(identity: PersistedTargetIdentity): string {
  return JSON.stringify(identity);
}

export function serializeSessionAuthority(authority: PersistedSessionAuthority): string {
  return JSON.stringify(authority);
}

export function parseTargetIdentity(value: string | null): PersistedTargetIdentity | null {
  const record = asRecord(value);
  if (record?.version !== 1) return null;
  if (typeof record.directoryHandle !== 'string' || record.directoryHandle.length === 0) return null;
  if (typeof record.canonicalPath !== 'string' || record.canonicalPath.length === 0) return null;
  const identity = parseFileIdentity(record);
  if (identity === null) return null;
  return {
    version: 1,
    directoryHandle: record.directoryHandle,
    canonicalPath: record.canonicalPath,
    ...identity,
  };
}

export function parseSessionAuthority(value: string | null): PersistedSessionAuthority | null {
  const record = asRecord(value);
  if (record?.version !== 1) return null;
  if (typeof record.profileId !== 'string' || record.profileId.length === 0) return null;
  if (typeof record.profileFingerprint !== 'string' || record.profileFingerprint.length === 0) return null;
  if (typeof record.effectivePermissionPolicy !== 'string' || record.effectivePermissionPolicy.length === 0) return null;
  if (typeof record.executionMode !== 'string' || !EXECUTION_MODES.has(record.executionMode)) return null;
  if (typeof record.unsafeProfile !== 'boolean') return null;
  if (!Array.isArray(record.sandboxArgs) || !record.sandboxArgs.every((token) => typeof token === 'string')) return null;
  if (record.reasoningEffort !== null && typeof record.reasoningEffort !== 'string') return null;
  const native = parseNativeCapability(record.nativeCapability);
  if (native === undefined) return null;
  return {
    version: 1,
    profileId: record.profileId,
    profileFingerprint: record.profileFingerprint,
    effectivePermissionPolicy: record.effectivePermissionPolicy,
    executionMode: record.executionMode as ResolvedAgentExecutionMode,
    unsafeProfile: record.unsafeProfile,
    sandboxArgs: [...record.sandboxArgs] as readonly string[],
    reasoningEffort: record.reasoningEffort,
    nativeCapability: native,
  };
}

/**
 * Proves that the recorded target is still the exact same directory. Path
 * equality alone is not enough: a replacement, remount, or symlink swap can
 * reproduce the path — and even the content — with a new file identity.
 * Nothing is mutated here, so a rejection leaves the prior terminal session and
 * its target untouched.
 */
export async function assertPersistedTargetUnchanged(identity: PersistedTargetIdentity): Promise<PersistedTargetIdentity> {
  const proof = await proveDirectoryIdentity(identity.canonicalPath, identity);
  if (proof.kind === 'inaccessible') {
    throw new InterleafError('security-violation', 'The recorded agent target directory is no longer accessible; this session cannot continue.', { cause: proof.cause });
  }
  if (proof.kind === 'replaced') {
    throw new InterleafError('security-violation', 'The recorded agent target directory was replaced; this session cannot continue.');
  }
  return identity;
}

/**
 * The registry is a convenience, not an authority: whatever it resolves now
 * must agree with the persisted record, and is never substituted for it.
 */
export function assertRegistryMatchesPersistedTarget(
  directory: FileIdentity & { readonly handle: string; readonly canonicalPath: string },
  identity: PersistedTargetIdentity,
): void {
  if (directory.handle !== identity.directoryHandle
    || directory.canonicalPath !== identity.canonicalPath
    || !sameFileIdentity(directory, identity)) {
    throw new InterleafError('security-violation', 'The registered working directory no longer matches this agent session’s recorded target.');
  }
}

/** The session row and its authority snapshot must still describe each other. */
export function assertAuthorityMatchesSession(
  session: { readonly executionMode: ResolvedAgentExecutionMode; readonly profileId: string; readonly directoryHandle: string },
  records: { readonly authority: PersistedSessionAuthority; readonly targetIdentity: PersistedTargetIdentity },
): void {
  if (records.authority.executionMode !== session.executionMode) {
    throw new InterleafError('security-violation', 'The recorded execution mode for this agent session no longer matches its authority snapshot.');
  }
  if (records.authority.profileId !== session.profileId) {
    throw new InterleafError('security-violation', 'The recorded agent profile for this session no longer matches its authority snapshot.');
  }
  if (records.targetIdentity.directoryHandle !== session.directoryHandle) {
    throw new InterleafError('security-violation', 'The recorded working directory for this agent session no longer matches its persisted identity.');
  }
}

/**
 * Direct authority may never drift. A profile edited after this session started
 * is a different authority, so the continuation fails closed instead of running
 * under a snapshot that no longer describes the adapter.
 */
export function assertDirectAuthorityUnchanged(
  executionMode: ResolvedAgentExecutionMode,
  current: { readonly profileFingerprint: string; readonly effectivePermissionPolicy: string },
  authority: PersistedSessionAuthority,
): void {
  if (executionMode !== 'active-env' && executionMode !== 'native-restricted') return;
  if (current.profileFingerprint !== authority.profileFingerprint
    || current.effectivePermissionPolicy !== authority.effectivePermissionPolicy) {
    throw new InterleafError('security-violation', 'The agent profile changed after this direct-workspace session started; start a new session instead of resuming under the old authority.');
  }
}

/**
 * A capability proof only counts when it describes the exact contract,
 * executable, and argv tokens this session was authorized under.
 */
export function matchesRecordedCapability(
  proof: { readonly contractId: string; readonly executableFingerprint: string; readonly resumeSandboxArgs: readonly string[] } | null,
  expected: { readonly contractId: string | null; readonly executableFingerprint: string | null; readonly resumeSandboxArgs: readonly string[] } | null,
): boolean {
  return proof !== null
    && proof.contractId === expected?.contractId
    && proof.executableFingerprint === expected.executableFingerprint
    && sameTokens(proof.resumeSandboxArgs, expected.resumeSandboxArgs);
}

export type PersistedSessionRecords = {
  readonly targetIdentity: PersistedTargetIdentity;
  readonly authority: PersistedSessionAuthority;
};

/**
 * Both records must be present and parseable for a session to be continued at
 * all: a privileged continuation has no other statement of what it was
 * authorized to do.
 */
export function requireSessionRecords(stored: {
  readonly targetIdentity: PersistedTargetIdentity | null;
  readonly authority: PersistedSessionAuthority | null;
} | null): PersistedSessionRecords {
  const targetIdentity = stored?.targetIdentity ?? null;
  const authority = stored?.authority ?? null;
  if (targetIdentity === null || authority === null) {
    throw new InterleafError('security-violation', 'This agent session has no readable target identity or permission snapshot and cannot be continued.');
  }
  return { targetIdentity, authority };
}

/**
 * Builds the snapshot persisted at session creation. The capability fields are
 * derived from the proof taken at that moment, so a session started without a
 * native proof can never later claim one.
 */
export function buildSessionAuthority(
  resolved: Omit<PersistedSessionAuthority, 'version' | 'sandboxArgs' | 'nativeCapability'>,
  verifiedNative: {
    readonly contractId: string;
    readonly executableFingerprint: string;
    readonly resumeSandboxArgs: readonly string[];
  } | null,
): PersistedSessionAuthority {
  return {
    version: 1,
    ...resolved,
    sandboxArgs: verifiedNative?.resumeSandboxArgs ?? [],
    nativeCapability: verifiedNative === null
      ? null
      : { contractId: verifiedNative.contractId, executableFingerprint: verifiedNative.executableFingerprint },
  };
}

/** The capability a session was authorized under, in comparison form. */
export function recordedCapability(authority: PersistedSessionAuthority): {
  readonly contractId: string | null;
  readonly executableFingerprint: string | null;
  readonly resumeSandboxArgs: readonly string[];
} {
  return {
    contractId: authority.nativeCapability?.contractId ?? null,
    executableFingerprint: authority.nativeCapability?.executableFingerprint ?? null,
    resumeSandboxArgs: authority.sandboxArgs,
  };
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

/** `undefined` means "malformed"; `null` means "explicitly absent". */
function parseNativeCapability(value: PortableMember): PersistedSessionAuthority['nativeCapability'] | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as PortableRecord;
  if (typeof record.contractId !== 'string' || record.contractId.length === 0) return undefined;
  if (typeof record.executableFingerprint !== 'string' || record.executableFingerprint.length === 0) return undefined;
  return { contractId: record.contractId, executableFingerprint: record.executableFingerprint };
}

function asRecord(value: string | null): PortableRecord | null {
  if (value === null || value.length === 0) return null;
  try {
    const parsed: PortableValue = parsePortableJson(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as PortableRecord
      : null;
  } catch {
    return null;
  }
}
