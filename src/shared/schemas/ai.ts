import { z } from 'zod';
import {
  AI_PROVIDER_IDS,
  CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS,
  CHAT_CONTEXT_ITEM_MAX_TEXT_UNITS,
  CHAT_MAX_CONTEXT_ITEMS,
  CHAT_MAX_PAGE_RANGE,
  CHAT_MESSAGE_MAX_TEXT_UNITS,
  CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS,
} from '../constants/ai';
import { CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH } from '../constants/chat-wire';
import { REASONING_EFFORTS, REASONING_MAX_LEVELS } from '../constants/reasoning';
import { chatSelectionDescriptorSchema, documentLocationSchema } from './document';
const identifierSchema = z.string().min(1).max(128);
const documentHashSchema = z.string().min(1).max(256);
const requestIdSchema = z.uuid();
const sessionTitleSchema = z.string().trim().min(1).max(200);
const OPENROUTER_MODEL_ID_REGEX =
  /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/;

/** OpenRouter's public key format. The secret itself remains main-owned and
 * is never returned through IPC or included in diagnostics. */
export const openRouterApiKeySchema = z
  .string()
  .trim()
  .min(1, 'OpenRouter API key cannot be empty.')
  .max(512, 'OpenRouter API key exceeds the maximum length of 512 characters.')
  .regex(/^sk-or-v1-[A-Za-z0-9_-]+$/u, 'OpenRouter API key format is invalid.');

export const openRouterModelIdSchema = z
  .string()
  .trim()
  .min(1, 'Model identifier cannot be empty.')
  .max(128, 'Model identifier exceeds maximum length of 128 characters.')
  .regex(
    OPENROUTER_MODEL_ID_REGEX,
    'Model identifier must be formatted as provider/model with an optional single :variant suffix, using alphanumeric characters, dots, hyphens, or underscores without spaces or path traversals.'
  )
  .refine(
    (val) =>
      !val.includes('..') &&
      !val.startsWith('/') &&
      !val.endsWith('/') &&
      !val.startsWith(':') &&
      !val.endsWith(':'),
    {
      message:
        'Model identifier cannot contain relative traversals or leading/trailing slashes or colons.',
    }
  );

export const modelIdSchema = z
  .string()
  .trim()
  .min(1, 'Model identifier cannot be empty.')
  .max(128, 'Model identifier exceeds maximum length of 128 characters.');

export const aiProviderIdSchema = z.enum(AI_PROVIDER_IDS);

export const aiModelPriceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('priced'), usdPerToken: z.number().positive() }).strip(),
  z.object({ kind: z.literal('free') }).strip(),
  z.object({ kind: z.literal('unavailable') }).strip(),
  z.object({ kind: z.literal('not_published') }).strip(),
]);

export const aiModelPricingSchema = z.object({ input: aiModelPriceSchema, output: aiModelPriceSchema }).strip();

const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

/**
 * The reasoning levels main verified a model accepts, from that provider's own
 * metadata. Absent means none were verified: the model is offered with no
 * reasoning control, never with a guessed one.
 */
export const aiModelReasoningSchema = z.object({
  levels: z
    .array(reasoningEffortSchema)
    .min(1)
    .max(REASONING_MAX_LEVELS)
    .refine((levels) => new Set(levels).size === levels.length, 'Reasoning levels must be unique.'),
}).strict();

export const aiModelInfoSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  contextWindow: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  supportsStreaming: z.boolean(),
  // Absent for CLI and deterministic providers, which publish no pricing.
  pricing: aiModelPricingSchema.exactOptional(),
  reasoning: aiModelReasoningSchema.exactOptional(),
}).strip();

export const aiProviderCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  subscriptionAuth: z.boolean(),
  apiKeyAuth: z.boolean(),
  persistentSessions: z.boolean(),
  toolFreeMode: z.boolean(),
  hostedWebSearch: z.boolean(),
}).strip();

/** Renderer-facing provider status. Canonical executable paths are forbidden. */
export const aiProviderStatusSchema = z.object({
  id: aiProviderIdSchema,
  name: z.string().min(1).max(256),
  available: z.boolean(),
  /** Safe renderer-facing state; canonical executable paths remain main-only. */
  installed: z.boolean(),
  authentication: z.enum(['connected', 'disconnected', 'unknown', 'error']),
  version: z.string().max(256).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
  models: z.array(aiModelInfoSchema).max(128),
  capabilities: aiProviderCapabilitiesSchema,
}).strip();

export const aiProviderStatusListSchema = z.array(aiProviderStatusSchema).max(16);

export const createChatSessionRequestSchema = z.object({
  documentId: identifierSchema,
  // Absent gives the session its default title.
  title: sessionTitleSchema.exactOptional(),
  providerId: aiProviderIdSchema,
  // `null` binds the provider's default model.
  modelId: modelIdSchema.nullable(),
  // Absent or `null` lets the model decide; main checks any level against the
  // model this session will actually run before storing it.
  reasoningEffort: reasoningEffortSchema.nullable().exactOptional(),
}).strict();

/**
 * Session-only request shape for operations whose document scope is resolved in
 * main from the stored session row. Kept separate from
 * `getChatSessionRequestSchema` so the detail lookup can require an explicit
 * document ID without widening the other session channels.
 */
const chatSessionRequestSchema = z.object({ sessionId: identifierSchema }).strict();

/**
 * Detail hydration is document-scoped at the contract boundary: the caller must
 * name the document it believes owns the session, and main rejects the lookup
 * when that claim does not match the stored row.
 */
export const getChatSessionRequestSchema = z.object({
  sessionId: identifierSchema,
  documentId: identifierSchema,
}).strict();

export const listChatSessionsRequestSchema = z.object({ documentId: identifierSchema }).strict();

export const updateChatSessionRequestSchema = z.object({
  sessionId: identifierSchema,
  title: sessionTitleSchema.exactOptional(),
  providerId: aiProviderIdSchema.exactOptional(),
  // Patch semantics: absent leaves the model unchanged, `null` selects the
  // provider's default model.
  modelId: modelIdSchema.nullable().exactOptional(),
  // Patch semantics with one exception: a provider or model change that names
  // no level resets the session to the model's default, so a level chosen for
  // one model is never carried onto another. `null` selects that default.
  reasoningEffort: reasoningEffortSchema.nullable().exactOptional(),
}).strict().refine(
  (value) =>
    value.title !== undefined ||
    value.providerId !== undefined ||
    value.modelId !== undefined ||
    value.reasoningEffort !== undefined,
  'At least one session field must be updated.'
);

export const deleteChatSessionRequestSchema = chatSessionRequestSchema;
export const listChatMessagesRequestSchema = chatSessionRequestSchema;
export const listChatContextRequestSchema = chatSessionRequestSchema;
export const getChatContextBudgetRequestSchema = chatSessionRequestSchema;

/**
 * Renderer-side result contract for `chat:get-context-budget`. The preload
 * bridge parses every reply with this schema, so a malformed or widened main
 * response is rejected instead of being rendered as a truthful figure.
 */
const tokenCountSchema = z.number().int().nonnegative();

/**
 * The itemised charges behind the aggregate. `documentSerializationTokens` is
 * the framing's share of `documentContextTokens`, so it is bounded by it and is
 * deliberately absent from the sum the aggregate is checked against.
 */
export const chatContextBudgetBreakdownSchema = z
  .object({
    systemPromptTokens: tokenCountSchema,
    userPromptTokens: tokenCountSchema,
    historyTokens: tokenCountSchema,
    documentContextTokens: tokenCountSchema,
    documentSerializationTokens: tokenCountSchema,
    safetyHeadroomTokens: tokenCountSchema,
    reservedResponseTokens: tokenCountSchema,
  })
  .strict()
  .refine(
    (value) => value.documentSerializationTokens <= value.documentContextTokens,
    'Serialization overhead cannot exceed the context envelope that contains it.'
  );

/** The components that make up the aggregate, in the order surfaces present them. */
function chatContextBudgetComponentTotal(
  breakdown: z.infer<typeof chatContextBudgetBreakdownSchema>
): number {
  return (
    breakdown.systemPromptTokens +
    breakdown.userPromptTokens +
    breakdown.historyTokens +
    breakdown.documentContextTokens +
    breakdown.safetyHeadroomTokens +
    breakdown.reservedResponseTokens
  );
}

export const chatContextBudgetSchema = z
  .object({
    sessionId: identifierSchema,
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1).max(512),
    usedTokens: tokenCountSchema,
    totalTokens: z.number().int().positive().nullable(),
    accuracy: z.literal('estimated'),
    reservedOutputTokens: tokenCountSchema,
    sourceCount: tokenCountSchema,
    breakdown: chatContextBudgetBreakdownSchema,
  })
  .strict()
  // A breakdown that does not add up to the aggregate would let one surface
  // print two different totals for one request, so it is rejected here rather
  // than reconciled anywhere downstream.
  .refine(
    (value) => chatContextBudgetComponentTotal(value.breakdown) === value.usedTokens,
    'Context budget components must sum to the reported total.'
  )
  .refine(
    (value) => value.breakdown.reservedResponseTokens === value.reservedOutputTokens,
    'The reserved response band must match the reserved output allowance.'
  );

/** `null` is a valid reply: the session has packed no request under this binding. */
export const chatContextBudgetReplySchema = chatContextBudgetSchema.nullable();

export const contextAttachInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('selection'),
      descriptor: chatSelectionDescriptorSchema,
    })
    .strict(),
  z.object({ kind: z.literal('location'), location: documentLocationSchema }).strict(),
  z.object({
    kind: z.literal('range'),
    format: z.literal('pdf'),
    /** One-based, inclusive PDF page number. */
    pageStart: z.number().int().min(1).max(10_000_000),
    /** One-based, inclusive PDF page number. */
    pageEnd: z.number().int().min(1).max(10_000_000),
  }).strict().superRefine((value, context) => {
    if (value.pageEnd < value.pageStart) {
      context.addIssue({ code: 'custom', message: 'Page range is reversed.', path: ['pageEnd'] });
    } else if (value.pageEnd - value.pageStart + 1 > CHAT_MAX_PAGE_RANGE) {
      context.addIssue({ code: 'custom', message: 'Page range exceeds the safe maximum.', path: ['pageEnd'] });
    }
  }),
  z.object({
    kind: z.literal('entire_document'),
    location: documentLocationSchema,
    /**
     * True when Reader Chat attached the document on the user's behalf for a
     * question asked with nothing pinned. Automatic intent stays subject to
     * the ADR-0006 Level-2 ingestion ratio; the explicit action omits it and
     * keeps its pinned authority.
     */
    automatic: z.boolean().exactOptional(),
  }).strict(),
]);

export const attachChatContextRequestSchema = z.object({
  sessionId: identifierSchema,
  documentId: identifierSchema,
  documentHash: documentHashSchema,
  input: contextAttachInputSchema,
}).strict();

export const removeChatContextRequestSchema = z.object({
  sessionId: identifierSchema,
  contextItemId: identifierSchema,
}).strict();

export const sendChatMessageRequestSchema = z.object({
  sessionId: identifierSchema,
  content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_TEXT_UNITS),
  currentLocation: documentLocationSchema.exactOptional(),
  /**
   * Per-turn opt-in to the provider-hosted web search. The renderer is
   * untrusted, so this arrives as a strictly typed boolean that is validated
   * here and then re-checked against the bound provider's declared
   * `hostedWebSearch` capability in main. Absent means off.
   */
  webSearch: z.boolean().exactOptional(),
}).strict();

/**
 * `Clean Context` takes a session ID and nothing else.
 *
 * Everything the compaction needs — the owning document, the bound provider and
 * model, the transcript, any existing summary, and the attached context — is
 * resolved in main from that one row. The renderer cannot supply a transcript, a
 * model, or a summary of its own.
 */
export const cleanChatContextRequestSchema = chatSessionRequestSchema;

/**
 * Reply contract for `chat:clean-context`, parsed by the preload bridge. It
 * reports what changed, never the summary text: no renderer surface displays
 * it, so it does not cross the boundary.
 */
export const cleanChatContextReplySchema = z
  .object({
    sessionId: identifierSchema,
    compactedThroughOrdinal: z.number().int().min(0),
    summaryTextUnits: z.number().int().min(1).max(CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS),
    clearedContextItemIds: z.array(identifierSchema).max(CHAT_MAX_CONTEXT_ITEMS),
  })
  .strict();

/** A document's conversation list is long-tailed but not unbounded. */
const SESSION_LIST_MAX_ITEMS = 1_000;

/**
 * The typed session projection the renderer is allowed to see.
 *
 * It is main's own row reduced to display and readiness facts: the bound provider
 * and model, the stored message count and preview, whether the conversation is
 * archived, and how far a compaction has represented it. The stored compaction
 * summary is deliberately absent — no renderer surface shows it, so it does not
 * cross the boundary — and `.strict()` keeps a future main-side column from
 * reaching the renderer by accident.
 */
export const chatSessionSchema = z
  .object({
    id: identifierSchema,
    documentId: identifierSchema,
    documentHash: documentHashSchema,
    title: z.string().min(1).max(200),
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1).max(200).nullable(),
    /** The level the reader asked for; `null` lets the model decide. */
    reasoningEffort: reasoningEffortSchema.nullable(),
    messageCount: z.number().int().min(0),
    previewText: z.string().max(CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS).nullable(),
    compactedThroughOrdinal: z.number().int().min(0).nullable(),
    isArchived: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export const chatSessionReplySchema = chatSessionSchema.nullable();
export const chatSessionListReplySchema = z.array(chatSessionSchema).max(SESSION_LIST_MAX_ITEMS);

export const cancelChatRequestSchema = z.object({ requestId: requestIdSchema }).strict();

export const getAIProviderStatusRequestSchema = z.object({
  providerId: aiProviderIdSchema,
  /**
   * Bypass the provider's own status cache for this read.
   *
   * Set only by an explicit user action — "Check connection", or the refresh
   * that follows a confirmed endpoint change — where a cached answer would
   * describe the server the user just stopped pointing at. It widens no
   * boundary: the provider still probes the same fixed, validated endpoint by
   * the same read-only route.
   */
  forceRefresh: z.boolean().exactOptional(),
}).strict();

/**
 * Optional: a plain read may be answered from main's bounded readiness cache.
 * `forceRefresh` is for an explicit user check, which must probe again.
 */
export const listProvidersRequestSchema = z
  .object({
    forceRefresh: z.boolean().exactOptional(),
  })
  .strict()
  .optional();

export const listOpenRouterModelsRequestSchema = z
  .object({
    forceRefresh: z.boolean().exactOptional(),
  })
  .strict()
  .optional();

export const configureOpenRouterRequestSchema = z
  .object({
    // Empty is accepted for compatibility with callers that mean “preserve
    // the configured key”; the main service treats it as omitted.
    apiKey: z.union([openRouterApiKeySchema, z.literal('')]).exactOptional(),
    /** Stage credential removal with the model change; never save it alone. */
    removeKey: z.boolean().exactOptional(),
    model: openRouterModelIdSchema,
  })
  .strict()
  .refine(
    (value) => value.removeKey !== true || value.apiKey === undefined,
    {
      path: ['apiKey'],
      message: 'Remove key cannot be combined with a replacement API key.',
    }
  );

export const setCredentialRequestSchema = z.object({
  providerId: z.literal('openrouter'),
  secret: z.string().trim().min(1).max(512),
}).strict();

export const credentialProviderRequestSchema = z.object({
  providerId: z.literal('openrouter'),
}).strict();

export const resolveChatCitationRequestSchema = z.object({
  sessionId: identifierSchema,
  messageId: identifierSchema,
  sourceId: z.string().min(1).max(CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH),
}).strict();

export const storedChatContextTextSchema = z.string().max(CHAT_CONTEXT_ITEM_MAX_TEXT_UNITS);
