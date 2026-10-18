import { realpath } from 'node:fs/promises';
import type {
  AgentExecutionMode,
  ResolvedAgentExecutionMode,
} from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { RiskConfirmationGrantStore } from './risk-confirmation-grants';
import type { WorkingDirectoryRegistry } from './working-directory-registry';
import { buildMinimalChildEnvironment, execFileBounded } from './process-runner';
import { isPathWithin } from '../security/path-guard';
import { pickFileIdentity } from '../security/file-identity';

type RiskConfirmationGrantContext = {
  readonly grantId: string;
  readonly draftId: string;
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly effectivePermissionPolicy: string;
  readonly draftFingerprint: string;
  readonly ownerId: number;
  readonly store: RiskConfirmationGrantStore;
};

export type ModeResolverOptions = {
  readonly directoryHandle: string;
  readonly directoryRegistry: WorkingDirectoryRegistry;
  readonly riskConfirmationGrant?: RiskConfirmationGrantContext | undefined;
  /** Main-owned adapter capability probe; renderer input must never supply it. */
  readonly supportsNativeRestricted?: (profile: {
    readonly profileId: string;
    readonly profileFingerprint: string;
    readonly effectivePermissionPolicy: string;
  }) => Promise<boolean> | boolean;
  readonly isGitRepo?: ((canonicalTargetPath: string) => Promise<boolean>) | undefined;
};

/** Tokenized, bounded Git repository detection. Fake `.git` entries do not count. */
export async function defaultIsGitRepository(canonicalTargetPath: string): Promise<boolean> {
  try {
    const targetPath = await realpath(canonicalTargetPath);
    const { stdout } = await execFileBounded(
      'git',
      ['-C', targetPath, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      { encoding: 'utf8', shell: false, env: buildMinimalChildEnvironment(), timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true }
    );
    const lines = stdout.trim().split(/\r?\n/);
    if (lines[0] !== 'true' || lines.length < 2) {
      return false;
    }
    const repositoryRoot = await realpath(lines.slice(1).join('\n'));
    return isPathWithin(repositoryRoot, targetPath);
  } catch {
    return false;
  }
}

/** Main-owned fail-closed resolver for the normal auto-isolated preference. */
export async function resolveExecutionMode(
  requestedMode: AgentExecutionMode,
  options: ModeResolverOptions
): Promise<ResolvedAgentExecutionMode> {
  const registered = await options.directoryRegistry.resolve(options.directoryHandle);
  const checkGit = options.isGitRepo ?? defaultIsGitRepository;
  const isGit = await checkGit(registered.canonicalPath);

  switch (requestedMode) {
    case 'auto-isolated':
      return isGit ? 'isolated-worktree' : 'isolated-copy';
    case 'isolated-worktree':
      if (!isGit) {
        throw new InterleafError(
          'mode-resolution-failed',
          'Cannot use Isolated Worktree mode because the selected target is not a Git repository.'
        );
      }
      return 'isolated-worktree';
    case 'isolated-copy':
      return 'isolated-copy';
    case 'native-restricted': {
      const grant = requireDirectWorkspaceGrant('native-restricted', options, registered);
      const supportsRestrictedMode =
        (await options.supportsNativeRestricted?.({
          profileId: grant.profileId,
          profileFingerprint: grant.profileFingerprint,
          effectivePermissionPolicy: grant.effectivePermissionPolicy,
        })) ?? false;
      if (!supportsRestrictedMode) {
        throw new InterleafError(
          'mode-resolution-failed',
          'Native Restricted mode is unavailable because the selected agent profile has no verified native sandbox.'
        );
      }
      return 'native-restricted';
    }
    case 'container-sandbox':
      return 'container-sandbox';
    case 'active-env': {
      requireDirectWorkspaceGrant('active-env', options, registered);
      return 'active-env';
    }
    default: {
      const exhaustive: never = requestedMode;
      throw new InterleafError('mode-resolution-failed', `Unknown execution mode: ${String(exhaustive)}`);
    }
  }
}

function requireDirectWorkspaceGrant(
  mode: 'native-restricted' | 'active-env',
  options: ModeResolverOptions,
  registered: import('./working-directory-registry').RegisteredWorkingDirectory
): RiskConfirmationGrantContext {
  const grant = options.riskConfirmationGrant;
  const grantIsValid = grant?.store.consume(grant.grantId, {
      draftId: grant.draftId,
      directoryHandle: options.directoryHandle,
      profileId: grant.profileId,
      profileFingerprint: grant.profileFingerprint,
      effectivePermissionPolicy: grant.effectivePermissionPolicy,
      draftFingerprint: grant.draftFingerprint,
      ownerId: grant.ownerId,
      canonicalTargetPath: registered.canonicalPath,
      ...pickFileIdentity(registered),
      mode,
    }) ?? false;
  if (!grantIsValid || grant === undefined) {
    throw new InterleafError(
      'security-violation',
      `${mode === 'active-env' ? 'Active Environment' : 'Native Restricted'} mode is unavailable without a valid, bound, single-use confirmation grant.`
    );
  }
  return grant;
}
