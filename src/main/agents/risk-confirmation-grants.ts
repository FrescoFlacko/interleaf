import { randomUUID } from 'node:crypto';
import { type FileIdentity, sameFileIdentity } from '../security/file-identity';

const DEFAULT_GRANT_TTL_MS = 2 * 60 * 1000;

type DirectWorkspaceMode = 'native-restricted' | 'active-env';

export type RiskConfirmationGrantBinding = FileIdentity & {
  readonly draftId: string;
  readonly directoryHandle: string;
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly effectivePermissionPolicy: string;
  readonly canonicalTargetPath: string;
  readonly mode: DirectWorkspaceMode;
  /** Main-computed fingerprint of every bounded start-draft field. */
  readonly draftFingerprint: string;
  /** Bound Electron webContents identity. */
  readonly ownerId: number;
};

export type IssuedRiskConfirmationGrant = {
  readonly grantId: string;
  readonly expiresAt: number;
};

type StoredGrant = RiskConfirmationGrantBinding & {
  readonly expiresAt: number;
};

/**
 * Main-process-only store for short-lived, single-use risk confirmations.
 * The renderer receives only the random grant ID; every security-relevant
 * field is rebound and checked when the run is resolved.
 */
export class RiskConfirmationGrantStore {
  private readonly grants = new Map<string, StoredGrant>();

  issue(
    binding: RiskConfirmationGrantBinding,
    options?: { readonly now?: number; readonly ttlMs?: number }
  ): IssuedRiskConfirmationGrant {
    const now = options?.now ?? Date.now();
    const ttlMs = options?.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_GRANT_TTL_MS) {
      throw new Error('Risk confirmation grant TTL is outside the allowed range.');
    }

    const grantId = randomUUID();
    const expiresAt = now + ttlMs;
    this.grants.set(grantId, { ...binding, expiresAt });
    return { grantId, expiresAt };
  }

  consume(
    grantId: string,
    expected: RiskConfirmationGrantBinding,
    now = Date.now()
  ): boolean {
    const stored = this.grants.get(grantId);
    // Every lookup is single-use, including a mismatched replay attempt.
    this.grants.delete(grantId);
    if (stored === undefined || stored.expiresAt <= now) {
      return false;
    }
    return (
      stored.draftId === expected.draftId &&
      stored.directoryHandle === expected.directoryHandle &&
      stored.profileId === expected.profileId &&
      stored.profileFingerprint === expected.profileFingerprint &&
      stored.effectivePermissionPolicy === expected.effectivePermissionPolicy &&
      stored.canonicalTargetPath === expected.canonicalTargetPath &&
      sameFileIdentity(stored, expected) &&
      stored.mode === expected.mode &&
      stored.draftFingerprint === expected.draftFingerprint &&
      stored.ownerId === expected.ownerId
    );
  }
  clear(): void {
    this.grants.clear();
  }
}
