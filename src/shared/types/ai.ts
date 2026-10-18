import type { z } from 'zod';
import type { DocumentFormat, DocumentLocation } from './document';
import type {
  aiModelInfoSchema,
  aiModelPriceSchema,
  aiModelPricingSchema,
  aiModelReasoningSchema,
  aiProviderCapabilitiesSchema,
  aiProviderStatusSchema,
  chatContextBudgetBreakdownSchema,
  chatContextBudgetSchema,
  chatSessionSchema,
  cleanChatContextReplySchema,
  contextAttachInputSchema,
  createChatSessionRequestSchema,
  updateChatSessionRequestSchema,
} from '../schemas/ai';
import type {
  chatCitationSchema,
  chatContextDisclosureSchema,
  chatMessageSchema,
  chatSessionTitleChangedEventSchema,
  chatStreamEventSchema,
  chatWebSourceSchema,
} from '../schemas/chat-wire';
import type { PortableRecord } from '../models/portable';
import type {
  AI_PROVIDER_IDS,
  CHAT_CONTEXT_KINDS,
  CHAT_MESSAGE_STATUSES,
} from '../constants/ai';

/**
 * `fake` is retained only as a compile-time type for isolated test doubles.
 * It is intentionally absent from AI_PROVIDER_IDS and aiProviderIdSchema, so
 * it cannot cross the renderer/main IPC boundary or appear in production
 * provider status.
 */
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number] | 'fake';
export type ChatContextKind = (typeof CHAT_CONTEXT_KINDS)[number];
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

/**
 * Provider records carry `AIProviderId`, which also admits the test-only
 * `fake` provider that the IPC schemas reject.
 */
type WithProviderId<T> = Omit<T, 'providerId'> & { readonly providerId: AIProviderId };

export type AIProviderCapabilities = z.output<typeof aiProviderCapabilitiesSchema>;

/**
 * Explicit pricing availability for one billable direction (prompt input /
 * completion output) of a catalog model. Every state the UI can be in is
 * encoded here; renderers never infer availability from raw numbers.
 *
 * - `priced` — upstream published a finite positive USD-per-token figure in
 *   documented decimal/scientific notation. Interleaf imposes no artificial
 *   ceiling: every representable finite positive rate stays priced.
 * - `free` — upstream published an exact zero price for this direction.
 *   Real zero is preserved as Free and never collapses into an error state.
 * - `unavailable` — the direction HAS an advertised marker that Interleaf
 *   cannot truthfully present as a price: OpenRouter's undocumented negative
 *   sentinel (`-1`, observed only on its dynamic meta/routing models) or any
 *   other negative figure. Conservatively labeled "Price unavailable" —
 *   never claimed free, never claimed published, never applied to the model
 *   as a whole.
 * - `not_published` — this direction carries no usable price data: the field
 *   is absent inside a present pricing object, the entire pricing object is
 *   absent, or the text fails documented decimal/scientific lexical grammar
 *   (hexadecimal/binary/octal-like forms, 'Infinity'/'NaN', blanks, trailing
 *   junk) or converts to a non-finite number. Truthfully labeled
 *   "Not published".
 *
 * Primary sources (2026-08-27): https://openrouter.ai/openapi.json
 * (`PublicPricing.prompt/completion`: "Price in USD per token", type string;
 * no negative-sentinel documentation exists anywhere in the schema/docs),
 * https://openrouter.ai/api/v1/models live observations
 * (`openrouter/auto`, `openrouter/fusion`, … advertise `"prompt":"-1"`), and
 * https://openrouter.ai/docs/guides/routing/routers/auto-router.md
 * (Auto Router bills via routing, no fixed per-token figure).
 */
export type AIModelPrice = z.output<typeof aiModelPriceSchema>;
export type AIModelPricing = z.output<typeof aiModelPricingSchema>;
export type AIModelInfo = z.output<typeof aiModelInfoSchema>;
/** The reasoning levels main verified for one model; see `aiModelReasoningSchema`. */
export type AIModelReasoning = z.output<typeof aiModelReasoningSchema>;
export type { ReasoningEffort } from '../constants/reasoning';

export type AIProviderStatus = Omit<z.output<typeof aiProviderStatusSchema>, 'id'> & {
  readonly id: AIProviderId;
};

export type ChatSession = WithProviderId<z.output<typeof chatSessionSchema>>;
export type ChatSessionCreateInput = WithProviderId<z.input<typeof createChatSessionRequestSchema>>;
export type ChatSessionUpdateInput = Omit<z.input<typeof updateChatSessionRequestSchema>, 'providerId'> & {
  readonly providerId?: AIProviderId;
};

/**
 * Main-owned accounting for the last request a chat session actually packed.
 *
 * The renderer never computes, infers, or completes any field: it displays what
 * main supplies and shows nothing where main supplies nothing (including before
 * the session's first request, when no packed request exists).
 *
 * - `usedTokens` is the context builder's own estimate for that request, so it
 *   counts exactly what was sent — the selected history, the question, the
 *   serialized sources and the fixed reserve — and nothing that was not. It is
 *   a character-length estimate, never derived from file size and never exact:
 *   `accuracy` is the literal `'estimated'` so every surface must say so.
 * - `providerId`/`modelId` are the effective binding the request ran against,
 *   so a reader can tell whether the figure still describes the current one.
 * - `totalTokens` is the context window of that model as supplied by the
 *   provider layer, and is `null` whenever that window is missing or not a
 *   positive integer. A `null` total means no proportion can truthfully be
 *   drawn, so the renderer omits the ring rather than inventing a denominator.
 * - `breakdown` is the same estimate, itemised. Its components are the charges
 *   the builder applied, so they sum to `usedTokens` exactly and the renderer
 *   never has to reconstruct how the request was composed.
 */
export type ChatContextBudget = WithProviderId<z.output<typeof chatContextBudgetSchema>>;

/**
 * The itemised charges behind `ChatContextBudget.usedTokens`.
 *
 * Every component is a charge the context builder actually applied while
 * packing the request, taken from that build rather than re-derived, and the
 * six top-level components sum to `usedTokens` exactly — a rule the IPC schema
 * enforces at the boundary, so a renderer showing the parts and the total can
 * never show two different stories about one request.
 *
 * Interleaf sends the model no tool definitions, so there is no tool component
 * to report and none is invented.
 */
export type ChatContextBudgetBreakdown = z.output<typeof chatContextBudgetBreakdownSchema>;

export type ChatCitation = z.output<typeof chatCitationSchema>;
export type ChatContextDisclosure = z.output<typeof chatContextDisclosureSchema>;
export type ChatWebSource = z.output<typeof chatWebSourceSchema>;
export type ChatMessage = z.output<typeof chatMessageSchema>;

export type ChatContextItem = {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ChatContextKind;
  readonly sourceRef: PortableRecord;
  readonly excerptText: string;
  readonly excerptHash: string;
  readonly documentHash: string;
  readonly location: DocumentLocation;
  readonly provenance: PortableRecord;
  readonly displayLabel: string;
  readonly pinned: boolean;
  readonly createdAt: string;
};

export type ChatContextAttachInput = z.output<typeof contextAttachInputSchema>;

export type CitationTarget = {
  readonly documentId: string;
  readonly documentHash: string;
  readonly sourceId: string;
  readonly label: string;
  readonly location: DocumentLocation;
};

export type ChatSourceEnvelopeItem = {
  readonly sourceId: string;
  readonly documentId: string;
  readonly documentHash: string;
  readonly documentTitle: string;
  readonly documentFormat: DocumentFormat;
  readonly chunkId: string | null;
  readonly contextItemId: string | null;
  readonly location: DocumentLocation;
  readonly excerptText: string;
  readonly excerptHash: string;
  readonly heading: string | null;
  readonly pageLabel: string | null;
  readonly label: string;
};

export type ChatStreamEvent = z.output<typeof chatStreamEventSchema>;

/** A conversation's stored title changed on main's initiative; identifiers only. */
export type ChatSessionTitleChangedEvent = z.output<typeof chatSessionTitleChangedEventSchema>;

/**
 * What an accepted turn returns.
 *
 * It deliberately says nothing about context consumption: attached context is a
 * standing statement that survives the turns it is sent with, so there is no
 * per-turn consumption for a caller to reconcile. Context leaves a session only
 * when the reader removes an item or runs Clean Context.
 */
export type SendChatMessageResult = {
  readonly requestId: string;
  readonly userMessage: ChatMessage;
  readonly assistantMessage: ChatMessage;
};

/**
 * Outcome of one `Clean Context` compaction.
 *
 * The model-authored summary itself is deliberately absent: it is untrusted
 * conversation data that only main replays into later requests, and no surface
 * renders it, so it never crosses the IPC boundary.
 */
export type CleanChatContextResult = z.output<typeof cleanChatContextReplySchema>;
