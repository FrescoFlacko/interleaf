import type { AIModelInfo } from '@shared/types/ai';
import { credentialStorageBlocked, openRouterKeyIssue } from './credential-storage-ux';
import type { CredentialStorageStatus } from '@shared/schemas/credential-preview';
import type { OpenRouterCatalogState } from '../chat/use-openrouter-catalog';

const DEFAULT_OPENROUTER_MODEL = 'openrouter/auto';

/** The OpenRouter drafts Done is asked to commit, already trimmed. */
export type OpenRouterDrafts = {
  readonly key: string;
  readonly model: string;
  readonly savedModel: string;
};

/** What Done should do with the drafts. */
export type OpenRouterCommitPlan =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'invalid'; readonly keyError: string | null; readonly modelError: string | null }
  | { readonly kind: 'save' };

const CATALOG_UNSETTLED_MESSAGES: Readonly<Record<OpenRouterCatalogState, string>> = {
  error: 'The model catalog is unavailable. Retry it before saving a changed model.',
  loading: 'Wait for the OpenRouter model catalog to finish loading before saving a changed model.',
  idle: 'Select a model from the OpenRouter catalog before saving.',
  ready: 'Select a model from the OpenRouter catalog before saving.',
};

/**
 * Decides whether Done commits the OpenRouter drafts, and why it may not.
 *
 * A removal already took effect against the vault, so an untouched panel has
 * nothing left for Done to commit — and must not be asked for a key the reader
 * deliberately removed. Main will refuse a credential write when the OS has no
 * usable secret store, so Settings neither asks for a key nor sends one.
 */
export function planOpenRouterCommit({ drafts, aiSectionActive, credentialRemoved, storage, configured, catalog }: {
  readonly drafts: OpenRouterDrafts;
  readonly aiSectionActive: boolean;
  readonly credentialRemoved: boolean;
  readonly storage: CredentialStorageStatus | null;
  readonly configured: boolean;
  readonly catalog: { readonly models: readonly AIModelInfo[]; readonly state: OpenRouterCatalogState };
}): OpenRouterCommitPlan {
  const keyDirty = drafts.key.length > 0;
  const modelDirty = drafts.model !== drafts.savedModel;
  const storageBlocked = credentialStorageBlocked(storage);
  if (!keyDirty && !modelDirty && !(aiSectionActive && !credentialRemoved && !storageBlocked)) {
    return { kind: 'nothing' };
  }
  // Missing, malformed, and unstorable are one decision, made in
  // `openRouterKeyIssue` so this flow states the outcome rather than
  // re-deriving the grammar.
  const keyError = openRouterKeyIssue({ storageBlocked, configured, draft: drafts.key });
  const modelError = drafts.model.length === 0 ? 'Please select a valid model identifier.' : null;
  if (keyError !== null || modelError !== null) return { kind: 'invalid', keyError, modelError };

  const selectedCatalogModel = catalog.models.some((model) => model.id === drafts.model)
    || (!modelDirty && drafts.model === DEFAULT_OPENROUTER_MODEL);
  if (modelDirty && !selectedCatalogModel) {
    return { kind: 'invalid', keyError: null, modelError: CATALOG_UNSETTLED_MESSAGES[catalog.state] };
  }
  return { kind: 'save' };
}
