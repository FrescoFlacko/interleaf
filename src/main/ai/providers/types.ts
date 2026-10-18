import type {
  AIModelInfo,
  AIProviderCapabilities,
  AIProviderId,
  AIProviderStatus,
  ChatMessage,
  ChatSourceEnvelopeItem,
  ChatWebSource,
  ReasoningEffort,
} from '@shared/types/ai';

export type ProviderChatRequest = {
  readonly requestId: string;
  readonly modelId: string | null;
  readonly systemPrompt: string;
  readonly contextXml: string;
  readonly history: readonly ChatMessage[];
  readonly userMessage: string;
  readonly sources: readonly ChatSourceEnvelopeItem[];
  /**
   * Whether this single turn was opted into the provider's hosted web search.
   * Main sets it only after checking the provider's `hostedWebSearch`
   * capability, so a provider that does not declare the capability never
   * receives `true` and never has any tool surface enabled for it.
   */
  readonly webSearch: boolean;
  /**
   * A main-only cap on response tokens for a small internal call (conversation
   * naming). HTTP adapters send the smaller of this and the model's own limit;
   * CLI adapters cannot enforce it and ignore it. Absent for Reader Chat turns.
   */
  readonly maxResponseTokens?: number;
  /**
   * The reasoning level main revalidated against this turn's bound model.
   * Absent means Default: the adapter sends no override at all. Naming and
   * compaction never set it. Adapters check it again against their own model
   * metadata before building argv or a body, so a value can never reach a
   * provider that did not advertise it.
   */
  readonly reasoningEffort?: ReasoningEffort;
};

export { responseTokenLimit } from './response-token-limit';

export type ProviderChatEvent =
  | { readonly type: 'token'; readonly token: string }
  | {
    readonly type: 'done';
    readonly totalTokens?: number;
    /**
     * Sources the provider's own hosted search returned, handed over as
     * structured metadata. A provider must never stream these as `token`
     * events: tokens become the stored answer, and the stored answer is
     * replayed to the model as its own prior words.
     */
    readonly webSources?: readonly ChatWebSource[];
  };

export type AIProvider = {
  readonly id: AIProviderId;
  readonly name: string;
  readonly capabilities: AIProviderCapabilities;
  /**
   * Current availability and model catalog.
   *
   * `forceRefresh` asks a provider that caches its probe to discard it for this
   * read. Providers with nothing to cache may ignore it; none may treat it as
   * permission to do more than the probe it already performs.
   */
  detect(options?: { readonly forceRefresh?: boolean }): Promise<AIProviderStatus>;
  listModels(): Promise<readonly AIModelInfo[]>;
  resolveModel?(modelId: string | null): AIModelInfo;
  testConnection?(): Promise<{ readonly success: boolean; readonly message?: string }>;
  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent>;
  cancel(requestId: string): Promise<void>;
  /** Stop any provider-owned lifecycle work before the main process exits. */
  shutdown?(): Promise<void>;
};
