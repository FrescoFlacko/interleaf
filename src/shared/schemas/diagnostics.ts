import { z } from 'zod';
import { aiProviderIdSchema, modelIdSchema } from './ai';

/**
 * The private diagnostics contract shared by main, preload and the renderer.
 *
 * Main alone collects the packet, from a fixed allowlist: build and runtime
 * versions, the operating-system family and architecture, safe readiness enums
 * for the built-in AI providers and aggregate log counts. No field carries a
 * path, a host or user name, an identifier, document or chat text, a provider
 * message or a raw log line. The renderer receives an opaque handle bound to
 * the packet main collected, so preview, analysis and export always refer to
 * the same bytes; nothing the renderer sends can change the packet itself.
 */

export const DIAGNOSTICS_FORMAT = 'interleaf-diagnostics/1';

export const DIAGNOSTICS_LIMITS = {
  /** The optional issue description the user may add before analysis. */
  issueMaxLength: 2_000,
  /** The analysis text main accepts from a provider before stopping it. */
  analysisMaxLength: 16_000,
  /** The final report main builds; preview and export are this exact text. */
  reportMaxLength: 48_000,
  maxProviders: 16,
  maxLogCounts: 32,
} as const;

/**
 * Fixed warning and error events main counts in the durable log. Only the
 * code and a count leave main: never the message, its metadata or its time.
 */
const DIAGNOSTICS_SIGNAL_CODES = [
  'import-failed',
  'web-import-failed',
  'update-download-failed',
  'update-stage-failed',
  'update-install-failed',
  'provider-process-start-failed',
  'provider-capability-probe-failed',
  'provider-auth-probe-failed',
  'provider-sign-in-incomplete',
  'chat-model-listing-failed',
  'agent-model-discovery-failed',
  'agent-startup-persistence-failed',
  'startup-fatal',
  'settings-reset-to-defaults',
  'ipc-sender-rejected',
  'ipc-handler-failed',
  'conversation-naming-failed',
  'diagram-render-failed',
] as const;
export type DiagnosticsSignalCode = (typeof DIAGNOSTICS_SIGNAL_CODES)[number];

const LOG_CATEGORY_VALUES = ['app', 'library', 'reader', 'indexing', 'ai', 'agent', 'security', 'database'] as const;
const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const;

/** A dotted runtime version such as `40.1.0` or `22.20.0`; nothing else. */
const runtimeVersionSchema = z.string().min(1).max(32).regex(/^\d{1,5}(?:\.\d{1,6}){0,3}$/u);
/** The app version from `app.getVersion()`, which may carry a pre-release suffix. */
const appVersionSchema = z.string().min(1).max(64).regex(/^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/u);
const countSchema = z.number().int().min(0).max(1_000_000_000);

const diagnosticsProviderSchema = z.strictObject({
  id: aiProviderIdSchema,
  available: z.boolean(),
  installed: z.boolean(),
  authentication: z.enum(['connected', 'disconnected', 'unknown', 'error']),
  toolFreeMode: z.boolean(),
  hostedWebSearch: z.boolean(),
});
export type DiagnosticsProvider = z.infer<typeof diagnosticsProviderSchema>;

export const diagnosticsPacketSchema = z.strictObject({
  format: z.literal(DIAGNOSTICS_FORMAT),
  collectedAt: z.iso.datetime().max(40),
  app: z.strictObject({
    version: appVersionSchema,
    electron: runtimeVersionSchema,
    chrome: runtimeVersionSchema,
    node: runtimeVersionSchema,
    packaging: z.enum(['packaged', 'development']),
  }),
  os: z.strictObject({
    family: z.enum(['darwin', 'win32', 'linux', 'other']),
    arch: z.enum(['arm64', 'x64', 'ia32', 'arm', 'other']),
  }),
  providers: z.array(diagnosticsProviderSchema).max(DIAGNOSTICS_LIMITS.maxProviders),
  logs: z.strictObject({
    available: z.boolean(),
    scannedRecords: countSchema,
    truncated: z.boolean(),
    counts: z.array(z.strictObject({
      category: z.enum(LOG_CATEGORY_VALUES),
      level: z.enum(LOG_LEVEL_VALUES),
      count: countSchema,
    })).max(DIAGNOSTICS_LIMITS.maxLogCounts),
    signals: z.array(z.strictObject({
      code: z.enum(DIAGNOSTICS_SIGNAL_CODES),
      count: countSchema,
    })).max(DIAGNOSTICS_SIGNAL_CODES.length),
  }),
});
export type DiagnosticsPacket = z.infer<typeof diagnosticsPacketSchema>;

/** An opaque main-owned handle; it names one collected packet for one window. */
const diagnosticsHandleSchema = z.uuid();

/** A provider main verified can analyze the packet without tools, with its published models. */
const diagnosticsProviderChoiceSchema = z.strictObject({
  id: aiProviderIdSchema,
  models: z.array(z.strictObject({ id: modelIdSchema, name: z.string().min(1).max(256) })).max(128),
});
export type DiagnosticsProviderChoice = z.infer<typeof diagnosticsProviderChoiceSchema>;
/** The built-in providers diagnostics can name; never the test-only `fake`. */
export type DiagnosticsProviderId = DiagnosticsProviderChoice['id'];

export const diagnosticsCollectResultSchema = z.strictObject({
  handle: diagnosticsHandleSchema,
  packet: diagnosticsPacketSchema,
  /** The packet exactly as it is sent and exported. */
  packetText: z.string().min(1).max(DIAGNOSTICS_LIMITS.reportMaxLength),
  providers: z.array(diagnosticsProviderChoiceSchema).max(DIAGNOSTICS_LIMITS.maxProviders),
});
export type DiagnosticsCollectResult = z.infer<typeof diagnosticsCollectResultSchema>;

export const diagnosticsHandleRequestSchema = z.strictObject({ handle: diagnosticsHandleSchema });

export const diagnosticsIssueRequestSchema = z.strictObject({
  handle: diagnosticsHandleSchema,
  issue: z.string().max(DIAGNOSTICS_LIMITS.issueMaxLength),
});

export const diagnosticsAnalyzeRequestSchema = z.strictObject({
  handle: diagnosticsHandleSchema,
  providerId: aiProviderIdSchema,
  modelId: modelIdSchema.nullable(),
});

/** The reasons an analysis may stop. None carries provider text. */
const diagnosticsFailureSchema = z.enum([
  'provider-unavailable',
  'model-unavailable',
  'busy',
  'timeout',
  'too-long',
  'empty',
  'provider-failed',
  'cancelled',
]);
export type DiagnosticsFailure = z.infer<typeof diagnosticsFailureSchema>;

/**
 * The draft report preview: the sanitized issue text and the exact report
 * main would export, with or without an analysis.
 */
export const diagnosticsPreviewResultSchema = z.strictObject({
  issue: z.string().max(DIAGNOSTICS_LIMITS.issueMaxLength),
  report: z.string().min(1).max(DIAGNOSTICS_LIMITS.reportMaxLength),
});
export type DiagnosticsPreviewResult = z.infer<typeof diagnosticsPreviewResultSchema>;

export const diagnosticsAnalyzeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('complete'),
    issue: z.string().max(DIAGNOSTICS_LIMITS.issueMaxLength),
    report: z.string().min(1).max(DIAGNOSTICS_LIMITS.reportMaxLength),
  }),
  z.strictObject({ status: z.literal('failed'), reason: diagnosticsFailureSchema }),
]);
export type DiagnosticsAnalyzeResult = z.infer<typeof diagnosticsAnalyzeResultSchema>;

export const diagnosticsExportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('success'), bytes: countSchema, fileName: z.string().min(1).max(255) }),
]);
export type DiagnosticsExportResult = z.infer<typeof diagnosticsExportResultSchema>;
