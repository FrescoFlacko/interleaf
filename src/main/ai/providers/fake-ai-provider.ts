import type { AIModelInfo, AIProviderCapabilities, AIProviderStatus } from '@shared/types/ai';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from './types';

const MODELS: readonly AIModelInfo[] = [
  {
    id: 'fake-grounded',
    name: 'Deterministic Grounded Model',
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    supportsStreaming: true,
  },
];

export type FakeAIProviderOptions = {
  /** Test-only fixture switch; defect 16 removes this provider entirely. */
  readonly enableMarkdownFixture?: boolean;
};

export class FakeAIProvider implements AIProvider {
  readonly id = 'fake' as const;
  readonly name = 'Deterministic Test Provider';
  readonly capabilities: AIProviderCapabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    // The test double never reaches the network at all.
    hostedWebSearch: false,
  };

  private readonly active = new Map<string, AbortController>();

  private readonly enableMarkdownFixture: boolean;

  constructor(options: FakeAIProviderOptions = {}) {
    this.enableMarkdownFixture = options.enableMarkdownFixture === true;
  }

  detect(): Promise<AIProviderStatus> {
    return Promise.resolve({
      id: this.id,
      name: this.name,
      available: true,
      installed: true,
      authentication: 'connected',
      version: '1',
      errorMessage: null,
      models: [...MODELS],
      capabilities: this.capabilities,
    });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve(MODELS);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    const primary = request.sources[0];
    const citation = primary ? `[${primary.sourceId}]` : '';
    const normalizedQuestion = request.userMessage.toLocaleLowerCase();
    const answer = normalizedQuestion.includes('error-trigger')
      ? null
      : this.enableMarkdownFixture && normalizedQuestion.includes('markdown')
        ? `### Grounded Markdown\n\nThe deterministic provider returned a **formatted** answer with an _explicit_ structure ${citation}.\n\n- First supporting point\n- Second supporting point\n\n> Evidence remains grounded in the selected document.\n\n\`\`\`text\nstream-safe example\n\`\`\``
      : normalizedQuestion.includes('summar')
        ? `The supplied passages emphasize the document's main ideas and supporting details ${citation}.`
        : `The document context supports a grounded answer to your question ${citation}.`;
    try {
      if (answer === null) throw new Error('Simulated deterministic provider failure.');
      const pieces = answer.match(/\S+\s*/gu) ?? [answer];
      for (const token of pieces) {
        if (controller.signal.aborted) return;
        yield { type: 'token', token };
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
      }
      if (!controller.signal.aborted) yield { type: 'done', totalTokens: pieces.length };
    } finally {
      this.active.delete(request.requestId);
    }
  }

  cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.abort();
    this.active.delete(requestId);
    return Promise.resolve();
  }
}
