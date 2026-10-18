import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultIsGitRepository, resolveExecutionMode } from '@main/agents/mode-resolver';
import { RiskConfirmationGrantStore } from '@main/agents/risk-confirmation-grants';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { pickFileIdentity } from '@main/security/file-identity';

type GrantBinding = Parameters<RiskConfirmationGrantStore['issue']>[0];
type GrantFields = Pick<GrantBinding, 'draftId' | 'profileId' | 'profileFingerprint' | 'effectivePermissionPolicy' | 'draftFingerprint' | 'ownerId' | 'mode'>;

describe('agent mode resolver (ADR-0008)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-mode-resolver-'));
  const gitRepoDir = path.join(tmpDir, 'git-repo');
  const nestedGitDir = path.join(gitRepoDir, 'src', 'nested');
  const nonGitDir = path.join(tmpDir, 'non-git-dir');
  const fakeGitDir = path.join(tmpDir, 'fake-git-dir');

  mkdirSync(nestedGitDir, { recursive: true });
  mkdirSync(nonGitDir, { recursive: true });
  mkdirSync(fakeGitDir, { recursive: true });
  writeFileSync(path.join(fakeGitDir, '.git'), 'not a real gitdir\n');
  execFileSync('git', ['init', '--quiet', gitRepoDir], { stdio: 'ignore' });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A registered target plus the options every resolution against it shares. */
  async function registered(directory: string) {
    const registry = new WorkingDirectoryRegistry();
    const { handle } = await registry.register(directory);
    return { registry, handle, target: { directoryHandle: handle, directoryRegistry: registry } };
  }

  /** The Git target, a grant store, and a full binding for the given draft fields. */
  async function grantFixture(fields: GrantFields) {
    const { registry, handle, target } = await registered(gitRepoDir);
    const resolved = await registry.resolve(handle);
    const grants = new RiskConfirmationGrantStore();
    const binding: GrantBinding = {
      ...fields,
      directoryHandle: handle,
      canonicalTargetPath: realpathSync(gitRepoDir),
      ...pickFileIdentity(resolved),
    };
    /** What the renderer presents alongside a grant ID; `overrides` models a tampered draft. */
    const present = (grantId: string, overrides: Partial<GrantFields> = {}) => ({
      grantId,
      draftId: binding.draftId,
      profileId: binding.profileId,
      profileFingerprint: binding.profileFingerprint,
      effectivePermissionPolicy: binding.effectivePermissionPolicy,
      draftFingerprint: binding.draftFingerprint,
      ownerId: binding.ownerId,
      ...overrides,
      store: grants,
    });
    return { target, grants, binding, present };
  }

  it('detects real repositories and nested directories, not fake .git entries', async () => {
    expect(await defaultIsGitRepository(gitRepoDir)).toBe(true);
    expect(await defaultIsGitRepository(nestedGitDir)).toBe(true);
    expect(await defaultIsGitRepository(nonGitDir)).toBe(false);
    expect(await defaultIsGitRepository(fakeGitDir)).toBe(false);
  });

  it('resolves opaque handles to worktree for Git and copy for non-Git', async () => {
    const registry = new WorkingDirectoryRegistry();
    const git = await registry.register(gitRepoDir);
    const nonGit = await registry.register(nonGitDir);

    await expect(resolveExecutionMode('auto-isolated', { directoryHandle: git.handle, directoryRegistry: registry }))
      .resolves.toBe('isolated-worktree');
    await expect(resolveExecutionMode('auto-isolated', { directoryHandle: nonGit.handle, directoryRegistry: registry }))
      .resolves.toBe('isolated-copy');
  });

  it('fails closed for invalid and revoked handles', async () => {
    const { registry, handle, target } = await registered(nonGitDir);
    registry.revoke(handle);
    await expect(resolveExecutionMode('auto-isolated', target)).rejects.toThrow(/invalid or expired/i);
  });

  it('rejects explicit worktree mode for non-Git targets', async () => {
    const { target } = await registered(nonGitDir);
    await expect(resolveExecutionMode('isolated-worktree', target)).rejects.toThrow(/not a Git repository/i);
  });

  it('requires a bound, expiring, single-use grant for Active Environment', async () => {
    const { target, grants, binding, present } = await grantFixture({
      draftId: 'draft-1', profileId: 'profile-1', profileFingerprint: 'fingerprint-profile-1-v1',
      effectivePermissionPolicy: 'normal', mode: 'active-env', draftFingerprint: 'draft-1-fingerprint', ownerId: 1,
    });
    const grant = grants.issue(binding);

    await expect(resolveExecutionMode('active-env', target)).rejects.toThrow(/confirmation grant/i);
    await expect(resolveExecutionMode('active-env', { ...target, riskConfirmationGrant: present(grant.grantId) }))
      .resolves.toBe('active-env');
    await expect(resolveExecutionMode('active-env', { ...target, riskConfirmationGrant: present(grant.grantId) }))
      .rejects.toThrow(/confirmation grant/i);
  });

  it('consumes a mismatched grant so it cannot be replayed', async () => {
    const { target, grants, binding, present } = await grantFixture({
      draftId: 'draft-2', profileId: 'profile-2', profileFingerprint: 'fingerprint-profile-2-v1',
      effectivePermissionPolicy: 'normal', mode: 'active-env', draftFingerprint: 'draft-2-fingerprint', ownerId: 2,
    });
    const grant = grants.issue(binding);

    for (const profileId of ['wrong-profile', 'profile-2']) {
      await expect(resolveExecutionMode('active-env', { ...target, riskConfirmationGrant: present(grant.grantId, { profileId }) }))
        .rejects.toThrow(/confirmation grant/i);
    }
  });

  it('requires both a mode-bound grant and verified provider support for Native Restricted', async () => {
    const { target, grants, binding, present } = await grantFixture({
      draftId: 'draft-native', profileId: 'profile-native', profileFingerprint: 'fingerprint-profile-native-v1',
      effectivePermissionPolicy: 'workspace-write', mode: 'native-restricted', draftFingerprint: 'draft-native-fingerprint', ownerId: 3,
    });

    await expect(resolveExecutionMode('native-restricted', { ...target, supportsNativeRestricted: () => true }))
      .rejects.toThrow(/confirmation grant/i);

    const unsupportedGrant = grants.issue(binding);
    await expect(resolveExecutionMode('native-restricted', {
      ...target,
      riskConfirmationGrant: present(unsupportedGrant.grantId),
      supportsNativeRestricted: () => false,
    })).rejects.toThrow(/no verified native sandbox/i);

    const supportedGrant = grants.issue(binding);
    await expect(resolveExecutionMode('native-restricted', {
      ...target,
      riskConfirmationGrant: present(supportedGrant.grantId),
      supportsNativeRestricted: (profile) =>
        profile.profileId === binding.profileId &&
        profile.profileFingerprint === binding.profileFingerprint &&
        profile.effectivePermissionPolicy === binding.effectivePermissionPolicy,
    })).resolves.toBe('native-restricted');
  });

  it('cannot replay an Active Environment grant for Native Restricted', async () => {
    const { target, grants, binding, present } = await grantFixture({
      draftId: 'draft-cross-mode', profileId: 'profile-cross-mode', profileFingerprint: 'fingerprint-cross-mode-v1',
      effectivePermissionPolicy: 'normal', mode: 'active-env', draftFingerprint: 'draft-cross-mode-fingerprint', ownerId: 4,
    });
    const grant = grants.issue(binding);

    await expect(resolveExecutionMode('native-restricted', {
      ...target,
      riskConfirmationGrant: present(grant.grantId),
      supportsNativeRestricted: () => true,
    })).rejects.toThrow(/confirmation grant/i);
  });

  it('burns grants when the bounded draft fingerprint or sender binding mutates', async () => {
    const { target, grants, binding, present } = await grantFixture({
      draftId: 'draft-fingerprint', profileId: 'profile-fingerprint', profileFingerprint: 'profile-v1',
      effectivePermissionPolicy: 'normal', draftFingerprint: 'draft-v1', mode: 'active-env', ownerId: 7,
    });
    const grant = grants.issue(binding);
    await expect(resolveExecutionMode('active-env', {
      ...target, riskConfirmationGrant: present(grant.grantId, { draftFingerprint: 'draft-mutated' }),
    })).rejects.toThrow(/confirmation grant/i);
    const replay = grants.issue(binding);
    await expect(resolveExecutionMode('active-env', {
      ...target, riskConfirmationGrant: present(replay.grantId, { ownerId: 8 }),
    })).rejects.toThrow(/confirmation grant/i);
  });
});
