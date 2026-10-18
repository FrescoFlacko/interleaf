import type { z } from 'zod';
import {
  customAgentProfileConfigSchema,
  type createCustomAgentProfileRequestSchema,
  type CustomAgentProfileConfig,
  type ExecutableIdentity,
  type updateCustomAgentProfileRequestSchema,
} from '@shared/schemas/custom-agent-profile';
import type { StoredCustomAgentProfile } from '../db/repositories/custom-agent-profile-repository';
import { sameFileIdentity } from '../security/file-identity';

type CreateRequest = z.output<typeof createCustomAgentProfileRequestSchema>;
type UpdateRequest = z.output<typeof updateCustomAgentProfileRequestSchema>;
type ExecutionKind = CustomAgentProfileConfig['executionKind'];
type ExpertShellConfig = Extract<CustomAgentProfileConfig, { executionKind: 'expert-shell' }>;
type NormalConfig = Extract<CustomAgentProfileConfig, { executionKind: 'normal' }>;
/** The kind-specific members of a merge, before the schema validates the whole config. */
type ExpertShellFields = Pick<ExpertShellConfig, 'executionKind' | 'shellCommand' | 'resumeShellCommand' | 'promptDeliveryMode'> & {
  readonly shellFamily: ExpertShellConfig['shellFamily'] | undefined;
};
type NormalFields = Pick<NormalConfig, 'executionKind' | 'argvTemplate' | 'promptDeliveryMode' | 'resumeCommandTemplate'>;

/** An update request is a patch: an absent member keeps the stored value. */
function patched<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return value;
}

function expertConfigOf(config: CustomAgentProfileConfig): ExpertShellConfig | null {
  return config.executionKind === 'expert-shell' ? config : null;
}

function normalConfigOf(config: CustomAgentProfileConfig): NormalConfig | null {
  return config.executionKind === 'normal' ? config : null;
}

/** The validated persisted config for a newly created custom profile. */
export function buildCreatedConfig(request: CreateRequest): CustomAgentProfileConfig {
  const shared = {
    version: 1,
    stdoutParsingMode: request.stdoutParsingMode,
    defaultModel: request.defaultModel,
    reasoningEffort: request.reasoningEffort,
    supportsModelSelection: request.supportsModelSelection,
    supportsReasoningSelection: request.supportsReasoningSelection,
    supportsResume: request.supportsResume,
    workingDirectoryPolicy: request.workingDirectoryPolicy,
    defaultSandboxMode: request.defaultSandboxMode,
    environmentOverrides: request.environmentOverrides,
    unsafe: request.unsafe,
  };
  if (request.executionKind === 'expert-shell') {
    return customAgentProfileConfigSchema.parse({
      ...shared,
      executionKind: 'expert-shell',
      shellFamily: request.shellFamily,
      shellCommand: request.shellCommand,
      resumeShellCommand: request.resumeShellCommand,
      promptDeliveryMode: 'stdin',
    });
  }
  return customAgentProfileConfigSchema.parse({
    ...shared,
    executionKind: 'normal',
    argvTemplate: request.argvTemplate,
    promptDeliveryMode: request.promptDeliveryMode,
    resumeCommandTemplate: request.resumeCommandTemplate,
  });
}

/** The shell family an update leaves in force, when it targets Expert Shell. */
export function updatedShellFamily(existing: CustomAgentProfileConfig, request: UpdateRequest): ExpertShellConfig['shellFamily'] | undefined {
  return patched(request.shellFamily, expertConfigOf(existing)?.shellFamily);
}

/** The validated config an update produces, merged over the stored one. */
export function mergeUpdatedConfig(
  existing: CustomAgentProfileConfig,
  request: UpdateRequest,
  targetKind: ExecutionKind,
): CustomAgentProfileConfig {
  const shared = {
    version: 1,
    stdoutParsingMode: patched(request.stdoutParsingMode, existing.stdoutParsingMode),
    defaultModel: patched(request.defaultModel, existing.defaultModel),
    reasoningEffort: patched(request.reasoningEffort, existing.reasoningEffort),
    supportsModelSelection: patched(request.supportsModelSelection, existing.supportsModelSelection),
    supportsReasoningSelection: patched(request.supportsReasoningSelection, existing.supportsReasoningSelection),
    supportsResume: patched(request.supportsResume, existing.supportsResume),
    workingDirectoryPolicy: patched(request.workingDirectoryPolicy, existing.workingDirectoryPolicy),
    defaultSandboxMode: patched(request.defaultSandboxMode, existing.defaultSandboxMode),
    environmentOverrides: patched(request.environmentOverrides, existing.environmentOverrides),
    unsafe: patched(request.unsafe, existing.unsafe),
  };
  const kindFields = targetKind === 'expert-shell'
    ? mergeExpertShellFields(existing, request)
    : mergeNormalFields(existing, request);
  return customAgentProfileConfigSchema.parse({ ...shared, ...kindFields });
}

function mergeExpertShellFields(existing: CustomAgentProfileConfig, request: UpdateRequest): ExpertShellFields {
  const previous = expertConfigOf(existing);
  return {
    executionKind: 'expert-shell',
    shellFamily: updatedShellFamily(existing, request),
    shellCommand: patched(request.shellCommand, previous?.shellCommand ?? ''),
    resumeShellCommand: patched(request.resumeShellCommand, previous?.resumeShellCommand ?? null),
    promptDeliveryMode: 'stdin',
  };
}

function mergeNormalFields(existing: CustomAgentProfileConfig, request: UpdateRequest): NormalFields {
  const previous = normalConfigOf(existing);
  return {
    executionKind: 'normal',
    argvTemplate: patched(request.argvTemplate, previous?.argvTemplate ?? []),
    promptDeliveryMode: patched(request.promptDeliveryMode, existing.promptDeliveryMode),
    resumeCommandTemplate: patched(request.resumeCommandTemplate, previous?.resumeCommandTemplate ?? null),
  };
}

/**
 * Returns true only when an update changes the authority that can affect the
 * child command or executable. Display/configuration metadata is intentionally
 * excluded so renaming a profile or changing its parser does not re-show the
 * critical Expert Shell warning.
 */
export function executionAuthorityChanged(
  existing: Pick<StoredCustomAgentProfile, 'canonicalPath' | 'identity' | 'config'>,
  executable: { readonly canonicalPath: string; readonly identity: ExecutableIdentity },
  next: CustomAgentProfileConfig,
): boolean {
  const executableChanged = existing.canonicalPath !== executable.canonicalPath
    || !sameExecutableIdentity(existing.identity, executable.identity);
  if (executableChanged) return true;
  const previous = existing.config;
  if (previous.executionKind === 'expert-shell' && next.executionKind === 'expert-shell') {
    return expertShellAuthorityChanged(previous, next);
  }
  if (previous.executionKind === 'normal' && next.executionKind === 'normal') {
    return normalAuthorityChanged(previous, next);
  }
  return true;
}

function expertShellAuthorityChanged(previous: ExpertShellConfig, next: ExpertShellConfig): boolean {
  return previous.shellFamily !== next.shellFamily
    || previous.shellCommand !== next.shellCommand
    || previous.resumeShellCommand !== next.resumeShellCommand
    || sharedAuthorityChanged(previous, next);
}

function normalAuthorityChanged(previous: NormalConfig, next: NormalConfig): boolean {
  return JSON.stringify(previous.argvTemplate) !== JSON.stringify(next.argvTemplate)
    || JSON.stringify(previous.resumeCommandTemplate) !== JSON.stringify(next.resumeCommandTemplate)
    || previous.promptDeliveryMode !== next.promptDeliveryMode
    || sharedAuthorityChanged(previous, next);
}

function sharedAuthorityChanged(previous: CustomAgentProfileConfig, next: CustomAgentProfileConfig): boolean {
  return previous.supportsResume !== next.supportsResume
    || previous.defaultSandboxMode !== next.defaultSandboxMode
    || JSON.stringify(previous.environmentOverrides) !== JSON.stringify(next.environmentOverrides);
}

export function sameExecutableIdentity(left: ExecutableIdentity, right: ExecutableIdentity): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}
