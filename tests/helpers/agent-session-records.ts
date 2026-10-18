import type { PersistedSessionAuthority, PersistedTargetIdentity } from '../../src/main/agents/session-authority';

/**
 * Durable session records every `createSession` call must supply (schema
 * migration 24). Tests that do not exercise identity/authority drift use these
 * defaults so their intent stays readable.
 */
export function testTargetIdentity(overrides: Partial<PersistedTargetIdentity> = {}): PersistedTargetIdentity {
  return {
    version: 1,
    directoryHandle: 'dir-handle',
    canonicalPath: '/tmp/agent-fixture',
    device: 1,
    inode: 2,
    birthtimeNs: '3',
    ...overrides,
  };
}

export function testSessionAuthority(overrides: Partial<PersistedSessionAuthority> = {}): PersistedSessionAuthority {
  return {
    version: 1,
    profileId: 'codex',
    profileFingerprint: 'profile-fingerprint',
    effectivePermissionPolicy: 'workspace-write',
    executionMode: 'isolated-copy',
    unsafeProfile: false,
    sandboxArgs: [],
    reasoningEffort: null,
    nativeCapability: null,
    ...overrides,
  };
}
