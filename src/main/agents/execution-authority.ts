import { createHash } from 'node:crypto';
import type { MainAgentProfile } from './profile-types';
import type { PortableMember, PortableRecord } from '@shared/models/portable';

/**
 * An empty allowlist is recorded as `null`, the value it had before settings
 * defaulted the list, so upgrading does not orphan existing sessions.
 */
function recordedModels(models: MainAgentProfile['configuredModels']): readonly string[] | null {
  return models === undefined || models.length === 0 ? null : models;
}

/**
 * The single main-owned execution-authority fingerprint.
 *
 * One function produces the value used for risk-confirmation grant issuance and
 * consumption, for the authority snapshot persisted at session start, and for
 * the drift comparison performed on resume. Because all three read the same
 * derivation, a field that changes what Interleaf will execute cannot be
 * accepted by one of them and rejected by another.
 *
 * Every execution-affecting main-only field is included: the durable executable
 * identity (device, inode, birth time, size, mtime, and content SHA-256), the execution kind
 * and shell family, the start and resume argv templates and shell commands, the
 * prompt-delivery mode, the working-directory policy, the prompt root, the
 * environment policy and overrides, the unsafe flag, and the permission,
 * sandbox, model, and reasoning configuration.
 *
 * Every included field must also be durable across an application restart, or
 * an unchanged session could never be resumed. Deliberately excluded for that
 * reason, because none of them can change what is executed:
 *
 * - display-only detection state (availability, reported version, `checkedAt`,
 *   error message), which changes on every background re-detection;
 * - the opaque `executableHandle`, which is a process-local random capability
 *   token reissued by `ExecutableRegistry.rehydrate()` on every launch — the
 *   executable is bound instead by canonical `binaryPath` plus the durable
 *   identity below, which is strictly stronger;
 * - the profile's display `name`, which is a label only;
 * - `discoveredModels`, the runtime-only CLI listing probe result, which is
 *   never persisted and is therefore absent until a probe happens to run. The
 *   model a session executes under is the persisted effective model, and a new
 *   run's model is validated against the allowlist at launch, so the probe
 *   result carries no authority of its own.
 */
export function fingerprintExecutionAuthority(profile: MainAgentProfile): string {
  return createHash('sha256').update(canonicalize({
    version: 1,
    id: profile.id,
    providerId: profile.providerId,
    isCustom: profile.isCustom,
    unsafe: profile.unsafe,
    binaryPath: profile.binaryPath,
    // A reselected or replaced executable at the same path is a different
    // authority: the durable identity carries the content digest.
    executableIdentity: profile.executableIdentity ?? null,
    defaultArgs: profile.defaultArgs,
    permissionMode: profile.permissionMode,
    defaultSandboxMode: profile.defaultSandboxMode,
    defaultModel: profile.defaultModel,
    // Editing the allowlisted model set is a profile change, so it must
    // invalidate any outstanding direct-workspace grant like the others.
    configuredModels: recordedModels(profile.configuredModels),
    reasoningEffort: profile.reasoningEffort,
    environmentOverrides: profile.environmentOverrides ?? null,
    workingDirectoryPolicy: profile.workingDirectoryPolicy ?? null,
    promptRoot: profile.promptRoot ?? null,
    capabilities: profile.capabilities,
    custom: customExecutionAuthority(profile),
  })).digest('hex');
}

/**
 * The custom-profile half of the authority. Normal and Expert Shell profiles
 * are described by disjoint field sets, so both are listed explicitly and the
 * unused half is recorded as `null` rather than omitted — an absent key and a
 * null key must not collide.
 */
function customExecutionAuthority(profile: MainAgentProfile): PortableRecord | null {
  const config = profile.customConfig;
  if (config === undefined) return null;
  const shared = {
    version: config.version,
    executionKind: config.executionKind,
    promptDeliveryMode: config.promptDeliveryMode,
    stdoutParsingMode: config.stdoutParsingMode,
    defaultModel: config.defaultModel,
    reasoningEffort: config.reasoningEffort,
    supportsModelSelection: config.supportsModelSelection,
    supportsReasoningSelection: config.supportsReasoningSelection,
    supportsResume: config.supportsResume,
    workingDirectoryPolicy: config.workingDirectoryPolicy,
    defaultSandboxMode: config.defaultSandboxMode,
    environmentOverrides: config.environmentOverrides,
    unsafe: config.unsafe,
  };
  return config.executionKind === 'expert-shell'
    ? {
      ...shared,
      shellFamily: config.shellFamily,
      shellCommand: config.shellCommand,
      resumeShellCommand: config.resumeShellCommand,
      argvTemplate: null,
      resumeCommandTemplate: null,
    }
    : {
      ...shared,
      shellFamily: null,
      shellCommand: null,
      resumeShellCommand: null,
      argvTemplate: config.argvTemplate,
      resumeCommandTemplate: config.resumeCommandTemplate,
    };
}

/**
 * Stable serialization: object keys are emitted in sorted order at every depth,
 * so a value that merely changed insertion order does not read as drift, and
 * two different field sets can never serialize identically.
 */
function canonicalize(value: PortableMember): string {
  // An absent field and an explicitly null field must serialize identically,
  // so neither can be smuggled past the comparison as "no value".
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as PortableRecord;
  const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(',')}}`;
}
