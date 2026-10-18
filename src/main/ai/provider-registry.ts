import type { AIModelInfo, AIModelReasoning, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AppSettings, LocalProviderSettings } from '@shared/schemas/settings';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { SettingsRepository } from '../db/repositories/settings-repository';
import type { ChatModelLister, ChatModelListing, ListedChatProvider } from './chat-model-listing';
import type { CredentialVault } from './credential-vault';
import { CliAIProvider, createCliProviderDefinitions } from './providers/cli-ai-provider';
import { FakeAIProvider } from './providers/fake-ai-provider';
import { LocalProvider } from './providers/local-provider';
import { OpenRouterProvider } from './providers/openrouter-provider';
import { ProviderReadiness } from './provider-readiness';
import type { AIProvider } from './providers/types';
import type { Logger } from '../logging/logger';

/** Reader Chat CLIs with a bounded per-model listing. */
const LISTED_CHAT_CLIS: ReadonlySet<AIProviderId> = new Set<ListedChatProvider>(['codex', 'claude', 'pi']);

function isListedChatCli(providerId: AIProviderId): providerId is ListedChatProvider {
  return LISTED_CHAT_CLIS.has(providerId);
}

function listingFor(
  providerId: AIProviderId,
  lister: ChatModelLister | undefined,
): { readonly modelListing?: (binaryPath: string) => Promise<ChatModelListing | null> } {
  if (lister === undefined || !isListedChatCli(providerId)) return {};
  return { modelListing: (binaryPath) => lister.list(providerId, binaryPath) };
}

/** The Codex CLI provider, which alone offers ChatGPT sign-in. Its definition always ships. */
function codexProvider(providers: readonly CliAIProvider[]): CliAIProvider {
  const codex = providers.find((provider) => provider.id === 'codex');
  if (codex === undefined) throw new Error('The Codex CLI provider definition is missing.');
  return codex;
}

export class AIProviderRegistry {
  private readonly providers = new Map<AIProviderId, AIProvider>();
  private readonly codex: CliAIProvider;
  private readonly openRouter: OpenRouterProvider;
  private readonly modelListing: ChatModelLister | undefined;
  private readonly readiness: ProviderReadiness;

  constructor(input: {
    readonly chatRoot: string;
    readonly vault: CredentialVault;
    /** Honoured only when unpackaged. */
    readonly allowFakeProvider: boolean;
    readonly isPackaged: boolean;
    readonly logger: Logger;
    /**
     * Settings for the local loopback provider, read fresh on every use.
     *
     * A reader rather than a snapshot: the user can change endpoint or model
     * from Settings at any time, and the next status refresh or send must see
     * that immediately instead of a value captured at startup.
     */
    readonly readLocalSettings: () => LocalProviderSettings;
    /**
     * Main-owned bounded model listing, so a CLI subscription offers the models
     * and reasoning levels its installed CLI reports. `undefined` under
     * NODE_ENV=test, which leaves every listed CLI on its default model.
     */
    readonly modelListing: ChatModelLister | undefined;
  }) {
    this.modelListing = input.modelListing;
    const allowFake = !input.isPackaged && input.allowFakeProvider;
    if (allowFake) {
      this.register(new FakeAIProvider({
        // This branch is reachable only from an explicit main-owned test
        // harness; it is never enabled by NODE_ENV or renderer input.
        enableMarkdownFixture: process.env.NODE_ENV === 'test',
      }));
    }
    const cliProviders = createCliProviderDefinitions().map((definition) => new CliAIProvider(definition, input.chatRoot, {
      logger: input.logger,
      ...listingFor(definition.id, input.modelListing),
    }));
    for (const provider of cliProviders) this.register(provider);
    this.codex = codexProvider(cliProviders);
    this.register(new LocalProvider(input.readLocalSettings));
    this.openRouter = new OpenRouterProvider(input.vault);
    this.register(this.openRouter);
    // Only the CLIs are slow to detect. The local server keeps its own
    // endpoint-keyed cache and OpenRouter reads the vault, so both always
    // answer for the settings and credential they hold right now.
    this.readiness = new ProviderReadiness({
      probe: (providerId, options) => this.require(providerId).detect(options),
      cachedProviderIds: cliProviders.map((provider) => provider.id),
    });
  }

  /** Starts read-only CLI detection in the background, ahead of the first document. */
  prewarm(): void {
    this.readiness.prewarm();
  }

  async listStatuses(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIProviderStatus[]> {
    return Promise.all([...this.providers.keys()].map((providerId) => this.readiness.status(providerId, options)));
  }

  async getStatus(
    providerId: AIProviderId,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<AIProviderStatus> {
    this.require(providerId);
    return this.readiness.status(providerId, options);
  }

  async resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo> {
    const provider = this.require(providerId);
    if (provider.resolveModel) {
      return provider.resolveModel(modelId);
    }
    const models = await provider.listModels();
    const selected = modelId === null ? models[0] : models.find((model) => model.id === modelId);
    if (!selected) throw new InterleafError('validation', 'The selected AI model is unavailable.');
    return selected;
  }

  /**
   * The reasoning levels main verified for one resolved model. OpenRouter's
   * resolved model is synthetic, so its levels come from the catalog entry of
   * the same identifier; a catalog that cannot be read offers none.
   */
  async modelReasoning(providerId: AIProviderId, model: AIModelInfo): Promise<AIModelReasoning | null> {
    if (providerId !== 'openrouter') return model.reasoning ?? null;
    try {
      const catalog = await this.openRouter.listCatalogModels();
      return catalog.find((entry) => entry.id === model.id)?.reasoning ?? null;
    } catch {
      return null;
    }
  }

  async testConnection(providerId: AIProviderId): Promise<{ readonly success: boolean; readonly message?: string }> {
    const provider = this.require(providerId);
    if (provider.testConnection) {
      return provider.testConnection();
    }
    const status = await provider.detect();
    if (status.available && status.authentication === 'connected') {
      return { success: true, message: `${status.name} is connected.` };
    }
    return { success: false, message: status.errorMessage ?? `${status.name} is not connected.` };
  }

  async signInWithChatGPT(): Promise<AIProviderStatus> {
    const status = await this.codex.signInWithChatGPT();
    // Sign-in ends with a fresh detection, which replaces whatever was cached.
    this.readiness.record(status);
    return status;
  }

  async listOpenRouterModels(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIModelInfo[]> {
    return this.openRouter.listCatalogModels(options);
  }

  async configureOpenRouter(
    input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string },
    settings: SettingsRepository
  ): Promise<AppSettings> {
    return this.openRouter.configure(input, settings);
  }

  require(providerId: AIProviderId): AIProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new InterleafError('validation', 'AI provider is unavailable.');
    return provider;
  }

  async shutdown(): Promise<void> {
    this.readiness.shutdown();
    await Promise.allSettled([
      ...[...this.providers.values()].map((provider) => provider.shutdown?.() ?? Promise.resolve()),
      this.modelListing?.close() ?? Promise.resolve(),
    ]);
  }

  private register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }
}
