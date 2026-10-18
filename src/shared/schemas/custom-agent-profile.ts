import { z } from 'zod';
import { AGENT_DEFAULT_EXECUTION_MODES } from '../constants/agent-modes';

/**
 * The global as this module reads it: its self-reference, which every host
 * provides and which makes this a structural description rather than a guess,
 * and the one process member the platform check below needs. Shared code cannot
 * import Node, and the renderer has no `process` at all, so the member is
 * optional and the value behind it is inspected at runtime.
 */
type HostScope = {
  readonly globalThis: HostScope;
  readonly process?: { readonly platform?: string };
};

/** The host platform, when the host is one that names it. */
function hostPlatform(): string | undefined {
  const scope: HostScope = globalThis;
  const platform = scope.process?.platform;
  return typeof platform === 'string' ? platform : undefined;
}

const MAX_ARGV_TOKENS = 64;
const MAX_ARGV_TOKEN_LENGTH = 512;
const MAX_ARGV_BYTES = 16_384;
const placeholderPattern = /^\{\{(workingDir|promptFile|sessionId|model|reasoningEffort)\}\}$/u;

const executableHandleSchema = z.uuid();

/** Profile IDs are opaque main-issued identifiers, not executable handles. */
export const customAgentProfileIdSchema = z.string().trim().regex(/^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const executableSelectionSchema = z.object({
  handle: executableHandleSchema,
  displayName: z.string().trim().min(1).max(255),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict();

/** A template is an argv array. Placeholders are allowed only as whole tokens. */
const argvTokenSchema = z.string().min(1).max(MAX_ARGV_TOKEN_LENGTH).refine((token) => {
  if (token.includes('\0') || token.includes('\r') || token.includes('\n')) return false;
  if (!token.includes('{{') && !token.includes('}}')) return true;
  return placeholderPattern.test(token);
}, 'Arguments must be whole tokens; only {{workingDir}}, {{promptFile}}, {{sessionId}}, {{model}}, and {{reasoningEffort}} are allowed.')
  .refine((token) => token.toLowerCase() !== '--skip-git-repo-check', 'The Codex repository-check bypass is controlled by Interleaf execution mode.');

const argvTemplateSchema = z.array(argvTokenSchema).max(MAX_ARGV_TOKENS).superRefine((tokens, context) => {
  const bytes = new TextEncoder().encode(tokens.join('\0')).byteLength;
  if (bytes > MAX_ARGV_BYTES) context.addIssue({ code: 'custom', message: 'Argument template is too large.' });
});

const customAgentExecutionKindSchema = z.enum(['normal', 'expert-shell']);
const customAgentShellFamilySchema = z.enum(['posix', 'powershell', 'cmd']);
const MAX_SHELL_COMMAND_LENGTH = 16_384;
const shellCommandSchema = z.string().min(1).max(MAX_SHELL_COMMAND_LENGTH);
const resumeShellCommandSchema = z.string().min(1).max(MAX_SHELL_COMMAND_LENGTH);

const customAgentDefaultSandboxModeSchema = z.enum(AGENT_DEFAULT_EXECUTION_MODES);
export const customAgentPromptDeliveryModeSchema = z.enum(['stdin', 'temp-file']);
const customAgentStdoutParsingModeSchema = z.enum(['text', 'json-lines', 'none']);
/** Custom agents never receive an arbitrary renderer-selected cwd. The main
 * service resolves one directory per run and then passes its prepared
 * isolated workspace to the adapter. */
export const customAgentWorkingDirectoryPolicySchema = z.literal('select-per-run');
const SECRET_ENVIRONMENT_NAME_PATTERN = /(API|AUTH|BASH_ENV|BEARER|CERT|COOKIE|CREDENTIAL|ENV|KEY|LD_PRELOAD|NODE_OPTIONS|PASS(?:WORD|WD)?|PERL5OPT|PRIVATE|PYTHONPATH|RUBYOPT|SECRET|TOKEN|AWS|AZURE|GITHUB|GOOGLE|CLAUDE|ANTHROPIC|OPENROUTER|SSH|DYLD)/iu;
const SAFE_INHERIT_ENVIRONMENT_NAMES = new Set(['PATH', 'HOME', 'USER', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT']);

export const customAgentEnvironmentOverrideSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Z_][A-Z0-9_]*$/u),
  action: z.enum(['inherit-allowlisted', 'clear']),
}).strict().superRefine((value, context) => {
  if (SECRET_ENVIRONMENT_NAME_PATTERN.test(value.name)) {
    context.addIssue({ code: 'custom', path: ['name'], message: 'Secret-bearing environment variable names are not permitted.' });
  }
  if (value.action === 'inherit-allowlisted' && !SAFE_INHERIT_ENVIRONMENT_NAMES.has(value.name.toUpperCase())) {
    context.addIssue({ code: 'custom', path: ['name'], message: 'Only explicitly allowlisted host variables may be inherited.' });
  }
});

const customAgentEnvironmentOverridesSchema = z.array(customAgentEnvironmentOverrideSchema).max(32).superRefine((overrides, context) => {
  const names = new Set<string>();
  for (const [index, override] of overrides.entries()) {
    const key = override.name.toUpperCase();
    if (names.has(key)) context.addIssue({ code: 'custom', path: [index, 'name'], message: 'Environment variable names must be unique.' });
    names.add(key);
  }
});

function refineCustomProfileConfig(
  value: {
    readonly executionKind?: 'normal' | 'expert-shell' | undefined;
    readonly argvTemplate?: readonly string[] | undefined;
    readonly promptDeliveryMode?: z.output<typeof customAgentPromptDeliveryModeSchema> | undefined;
    readonly supportsResume?: boolean | undefined;
    readonly resumeCommandTemplate?: readonly string[] | null | undefined;
    readonly supportsModelSelection?: boolean | undefined;
    readonly defaultModel?: string | null | undefined;
    readonly supportsReasoningSelection?: boolean | undefined;
    readonly reasoningEffort?: string | null | undefined;
    readonly shellFamily?: 'posix' | 'powershell' | 'cmd' | undefined;
    readonly shellCommand?: string | undefined;
    readonly resumeShellCommand?: string | null | undefined;
  },
  context: z.RefinementCtx,
): void {
  const executionKind = value.executionKind ?? 'normal';
  const supportsResume = value.supportsResume ?? false;
  const supportsModelSelection = value.supportsModelSelection ?? false;
  const supportsReasoningSelection = value.supportsReasoningSelection ?? false;

  if (executionKind === 'expert-shell') {
    if (value.argvTemplate !== undefined && value.argvTemplate.length > 0) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Expert shell profiles do not accept an argument template.' });
    }
    if (value.resumeCommandTemplate !== undefined && value.resumeCommandTemplate !== null) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Expert shell profiles do not accept an argument resume template.' });
    }
    if (value.promptDeliveryMode !== undefined && value.promptDeliveryMode !== 'stdin') {
      context.addIssue({ code: 'custom', path: ['promptDeliveryMode'], message: 'Expert shell profiles require stdin prompt delivery.' });
    }
    if (value.shellFamily === undefined) {
      context.addIssue({ code: 'custom', path: ['shellFamily'], message: 'Expert shell profiles require a shell family.' });
    } else {
      const currentPlatform = hostPlatform();
      if (currentPlatform !== undefined) {
        if (value.shellFamily === 'cmd' && currentPlatform !== 'win32') {
          context.addIssue({ code: 'custom', path: ['shellFamily'], message: 'CMD shell family is only supported on Windows.' });
        }
        if (value.shellFamily === 'posix' && currentPlatform === 'win32') {
          context.addIssue({ code: 'custom', path: ['shellFamily'], message: 'POSIX shell family is not supported on Windows.' });
        }
      }
    }
    if (value.shellCommand === undefined || value.shellCommand.trim().length === 0) {
      context.addIssue({ code: 'custom', path: ['shellCommand'], message: 'Expert shell profiles require a shell command.' });
    }
    if (supportsResume) {
      if (value.resumeShellCommand === undefined || value.resumeShellCommand === null || value.resumeShellCommand.trim().length === 0) {
        context.addIssue({ code: 'custom', path: ['resumeShellCommand'], message: 'Resume capability requires a resume shell command in expert shell mode.' });
      }
    } else if (value.resumeShellCommand !== undefined && value.resumeShellCommand !== null && value.resumeShellCommand.trim().length > 0) {
      context.addIssue({ code: 'custom', path: ['resumeShellCommand'], message: 'Resume shell command requires session resume to be enabled.' });
    }
    if (!supportsModelSelection && value.defaultModel !== undefined && value.defaultModel !== null) {
      context.addIssue({ code: 'custom', path: ['defaultModel'], message: 'Default model requires model selection to be enabled.' });
    }
    if (!supportsReasoningSelection && value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
      context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Reasoning effort requires reasoning selection to be enabled.' });
    }
    return;
  }

  if (value.shellFamily !== undefined) {
    context.addIssue({ code: 'custom', path: ['shellFamily'], message: 'Shell family is only allowed on expert shell profiles.' });
  }
  if (value.shellCommand !== undefined) {
    context.addIssue({ code: 'custom', path: ['shellCommand'], message: 'Shell command is only allowed on expert shell profiles.' });
  }
  if (value.resumeShellCommand !== undefined && value.resumeShellCommand !== null) {
    context.addIssue({ code: 'custom', path: ['resumeShellCommand'], message: 'Resume shell command is only allowed on expert shell profiles.' });
  }

  const argvTemplate = value.argvTemplate ?? [];
  const resumeCommandTemplate = value.resumeCommandTemplate;
  const promptDeliveryMode = value.promptDeliveryMode;

  const EVAL_FLAGS: Record<string, true> = { '-c': true, '/c': true, '-command': true, '/command': true, '--command': true };
  if (argvTemplate.some((t) => EVAL_FLAGS[t.toLowerCase()] === true)) {
    context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Direct shell evaluation flags are not allowed in normal mode; use Expert Shell mode instead.' });
  }
  if (resumeCommandTemplate?.some((t) => EVAL_FLAGS[t.toLowerCase()] === true)) {
    context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Direct shell evaluation flags are not allowed in normal mode; use Expert Shell mode instead.' });
  }

  if (supportsResume) {
    if (resumeCommandTemplate === undefined || resumeCommandTemplate === null || resumeCommandTemplate.length === 0) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Resume capability requires a resume command template.' });
    } else if (!resumeCommandTemplate.includes('{{sessionId}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Resume template requires a {{sessionId}} argument token.' });
    }
  } else if (resumeCommandTemplate !== undefined && resumeCommandTemplate !== null && resumeCommandTemplate.length > 0) {
    context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Resume command template requires session resume to be enabled.' });
  }

  if (promptDeliveryMode === 'temp-file') {
    if (value.argvTemplate !== undefined && !argvTemplate.includes('{{promptFile}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Temp-file prompt delivery requires a {{promptFile}} argument token.' });
    }
    if (supportsResume && resumeCommandTemplate !== undefined && resumeCommandTemplate !== null && resumeCommandTemplate.length > 0 && !resumeCommandTemplate.includes('{{promptFile}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Temp-file prompt delivery requires a {{promptFile}} argument token in the resume template.' });
    }
  } else if (promptDeliveryMode === 'stdin') {
    if (argvTemplate.includes('{{promptFile}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'The {{promptFile}} token requires temp-file prompt delivery.' });
    }
    if (resumeCommandTemplate?.includes('{{promptFile}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'The {{promptFile}} token requires temp-file prompt delivery in the resume template.' });
    }
  }

  if (supportsModelSelection) {
    if (value.argvTemplate !== undefined && !argvTemplate.includes('{{model}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Model selection requires a {{model}} argument token.' });
    }
    if (supportsResume && resumeCommandTemplate !== undefined && resumeCommandTemplate !== null && resumeCommandTemplate.length > 0 && !resumeCommandTemplate.includes('{{model}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Model selection requires a {{model}} argument token in the resume template.' });
    }
  } else {
    if (argvTemplate.includes('{{model}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'The {{model}} token requires model selection to be enabled.' });
    }
    if (value.defaultModel !== undefined && value.defaultModel !== null) {
      context.addIssue({ code: 'custom', path: ['defaultModel'], message: 'Default model requires model selection to be enabled.' });
    }
    if (resumeCommandTemplate?.includes('{{model}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'The {{model}} token in resume template requires model selection to be enabled.' });
    }
  }

  if (supportsReasoningSelection) {
    if (value.argvTemplate !== undefined && !argvTemplate.includes('{{reasoningEffort}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Reasoning selection requires a {{reasoningEffort}} argument token.' });
    }
    if (supportsResume && resumeCommandTemplate !== undefined && resumeCommandTemplate !== null && resumeCommandTemplate.length > 0 && !resumeCommandTemplate.includes('{{reasoningEffort}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'Reasoning selection requires a {{reasoningEffort}} argument token in the resume template.' });
    }
  } else {
    if (argvTemplate.includes('{{reasoningEffort}}')) {
      context.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'The {{reasoningEffort}} token requires reasoning selection to be enabled.' });
    }
    if (value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
      context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Reasoning effort requires reasoning selection to be enabled.' });
    }
    if (resumeCommandTemplate?.includes('{{reasoningEffort}}')) {
      context.addIssue({ code: 'custom', path: ['resumeCommandTemplate'], message: 'The {{reasoningEffort}} token in resume template requires reasoning selection to be enabled.' });
    }
  }
}

const createProfileFields = {
  name: z.string().trim().min(1).max(120),
  executableHandle: executableHandleSchema,
  executionKind: customAgentExecutionKindSchema.default('normal'),
  // Kind-specific members: the refinement requires or rejects each per kind.
  argvTemplate: argvTemplateSchema.exactOptional(),
  promptDeliveryMode: customAgentPromptDeliveryModeSchema.default('stdin'),
  stdoutParsingMode: customAgentStdoutParsingModeSchema.default('text'),
  defaultModel: z.string().trim().min(1).max(128).nullable().default(null),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  supportsModelSelection: z.boolean().default(false),
  supportsReasoningSelection: z.boolean().default(false),
  resumeCommandTemplate: argvTemplateSchema.nullable().default(null),
  supportsResume: z.boolean().default(false),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema.default('select-per-run'),
  defaultSandboxMode: customAgentDefaultSandboxModeSchema.default('auto-isolated'),
  environmentOverrides: customAgentEnvironmentOverridesSchema.default([]),
  unsafe: z.boolean().default(false),
  shellFamily: customAgentShellFamilySchema.exactOptional(),
  shellCommand: shellCommandSchema.exactOptional(),
  resumeShellCommand: resumeShellCommandSchema.nullable().default(null),
} as const;

export const createCustomAgentProfileRequestSchema = z.object(createProfileFields).strict().superRefine((val, ctx) => {
  if (val.executionKind === 'normal') {
    if (val.argvTemplate === undefined) {
      ctx.addIssue({ code: 'custom', path: ['argvTemplate'], message: 'Arguments template is required for normal custom profiles.' });
    }
  }
  refineCustomProfileConfig(val, ctx);
});

/** A patch: an absent member keeps the stored value; `null` clears a nullable one. */
export const updateCustomAgentProfileRequestSchema = z.object({
  id: customAgentProfileIdSchema,
  name: z.string().trim().min(1).max(120).exactOptional(),
  executableHandle: executableHandleSchema.exactOptional(),
  executionKind: customAgentExecutionKindSchema.exactOptional(),
  argvTemplate: argvTemplateSchema.exactOptional(),
  promptDeliveryMode: customAgentPromptDeliveryModeSchema.exactOptional(),
  stdoutParsingMode: customAgentStdoutParsingModeSchema.exactOptional(),
  defaultModel: z.string().max(128).nullable().exactOptional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().exactOptional(),
  supportsModelSelection: z.boolean().exactOptional(),
  supportsReasoningSelection: z.boolean().exactOptional(),
  resumeCommandTemplate: argvTemplateSchema.nullable().exactOptional(),
  supportsResume: z.boolean().exactOptional(),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema.exactOptional(),
  defaultSandboxMode: customAgentDefaultSandboxModeSchema.exactOptional(),
  environmentOverrides: customAgentEnvironmentOverridesSchema.exactOptional(),
  unsafe: z.boolean().exactOptional(),
  shellFamily: customAgentShellFamilySchema.exactOptional(),
  shellCommand: shellCommandSchema.exactOptional(),
  resumeShellCommand: resumeShellCommandSchema.nullable().exactOptional(),
}).strict();

export const deleteCustomAgentProfileRequestSchema = z.object({ id: customAgentProfileIdSchema }).strict();
export const selectAgentExecutableRequestSchema = z.undefined();

const normalCustomAgentProfileSchema = z.object({
  id: customAgentProfileIdSchema,
  name: z.string().trim().min(1).max(120),
  executable: executableSelectionSchema.nullable(),
  executionKind: z.literal('normal').default('normal'),
  argvTemplate: argvTemplateSchema,
  promptDeliveryMode: customAgentPromptDeliveryModeSchema,
  stdoutParsingMode: customAgentStdoutParsingModeSchema,
  defaultModel: z.string().max(128).nullable().default(null),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  supportsModelSelection: z.boolean().default(false),
  supportsReasoningSelection: z.boolean().default(false),
  resumeCommandTemplate: argvTemplateSchema.nullable().default(null),
  supportsResume: z.boolean().default(false),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema,
  defaultSandboxMode: customAgentDefaultSandboxModeSchema,
  environmentOverrides: customAgentEnvironmentOverridesSchema,
  unsafe: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

const expertShellCustomAgentProfileSchema = z.object({
  id: customAgentProfileIdSchema,
  name: z.string().trim().min(1).max(120),
  executable: executableSelectionSchema.nullable(),
  executionKind: z.literal('expert-shell'),
  shellFamily: customAgentShellFamilySchema,
  shellCommand: shellCommandSchema,
  resumeShellCommand: resumeShellCommandSchema.nullable().default(null),
  promptDeliveryMode: z.literal('stdin').default('stdin'),
  stdoutParsingMode: customAgentStdoutParsingModeSchema,
  defaultModel: z.string().max(128).nullable().default(null),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  supportsModelSelection: z.boolean().default(false),
  supportsReasoningSelection: z.boolean().default(false),
  supportsResume: z.boolean().default(false),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema,
  defaultSandboxMode: customAgentDefaultSandboxModeSchema,
  environmentOverrides: customAgentEnvironmentOverridesSchema,
  unsafe: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const customAgentProfileSchema = z.discriminatedUnion('executionKind', [
  normalCustomAgentProfileSchema,
  expertShellCustomAgentProfileSchema,
]);

const normalConfigSchema = z.object({
  version: z.literal(1),
  executionKind: z.literal('normal').default('normal'),
  argvTemplate: argvTemplateSchema,
  promptDeliveryMode: customAgentPromptDeliveryModeSchema.default('stdin'),
  stdoutParsingMode: customAgentStdoutParsingModeSchema.default('text'),
  defaultModel: z.string().max(128).nullable().default(null),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  supportsModelSelection: z.boolean().default(false),
  supportsReasoningSelection: z.boolean().default(false),
  resumeCommandTemplate: argvTemplateSchema.nullable().default(null),
  supportsResume: z.boolean().default(false),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema.default('select-per-run'),
  defaultSandboxMode: customAgentDefaultSandboxModeSchema.default('auto-isolated'),
  environmentOverrides: customAgentEnvironmentOverridesSchema.default([]),
  unsafe: z.boolean().default(false),
  shellFamily: z.undefined().optional(),
  shellCommand: z.undefined().optional(),
  resumeShellCommand: z.undefined().optional(),
}).strict();

const expertShellConfigSchema = z.object({
  version: z.literal(1),
  executionKind: z.literal('expert-shell'),
  shellFamily: customAgentShellFamilySchema,
  shellCommand: shellCommandSchema,
  resumeShellCommand: resumeShellCommandSchema.nullable().default(null),
  promptDeliveryMode: z.literal('stdin').default('stdin'),
  stdoutParsingMode: customAgentStdoutParsingModeSchema.default('text'),
  defaultModel: z.string().max(128).nullable().default(null),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  supportsModelSelection: z.boolean().default(false),
  supportsReasoningSelection: z.boolean().default(false),
  supportsResume: z.boolean().default(false),
  workingDirectoryPolicy: customAgentWorkingDirectoryPolicySchema.default('select-per-run'),
  defaultSandboxMode: customAgentDefaultSandboxModeSchema.default('auto-isolated'),
  environmentOverrides: customAgentEnvironmentOverridesSchema.default([]),
  unsafe: z.boolean().default(false),
  argvTemplate: z.undefined().optional(),
  resumeCommandTemplate: z.undefined().optional(),
}).strict();

export const customAgentProfileConfigSchema = z.preprocess(
  (val) => (typeof val === 'object' && val !== null && !('executionKind' in val) ? { ...val, executionKind: 'normal' } : val),
  z.discriminatedUnion('executionKind', [
    normalConfigSchema,
    expertShellConfigSchema,
  ]),
).superRefine(refineCustomProfileConfig);

export const executableIdentitySchema = z.object({
  device: z.number().nonnegative(),
  inode: z.number().nonnegative(),
  /** Nanosecond birth time (see `src/main/security/file-identity.ts`); `null` is unprovable and fails closed. */
  birthtimeNs: z.string().regex(/^[1-9][0-9]{0,30}$/u).nullable(),
  size: z.number().int().nonnegative().max(512 * 1024 * 1024),
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict();

export type CustomAgentProfileConfig = z.infer<typeof customAgentProfileConfigSchema>;
export type ExecutableIdentity = z.infer<typeof executableIdentitySchema>;

