import { aiProviderDisplayName, CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import type { ProviderDiscoveryState } from '../../stores/use-chat-store';

/**
 * Reader Chat's shorter names where the canonical label explains more than a
 * chat needs: the codex binding reads as plain `ChatGPT` here, while Settings
 * keeps `ChatGPT (subscription)` beside its CLI and sign-in details.
 */
const READER_CHAT_PROVIDER_NAMES: Partial<Record<AIProviderId, string>> = { codex: 'ChatGPT' };

/**
 * Normalizes a backend-supplied provider name for Reader Chat display.
 * Canonical labels win over the transport name so the binding readout cannot
 * fall back to a value such as `Codex CLI`.
 */
export function displayProviderName(providerId: AIProviderId, name: string | null | undefined): string {
  return READER_CHAT_PROVIDER_NAMES[providerId] ?? aiProviderDisplayName(providerId, name);
}

/** Strips case and punctuation so `openrouter/auto` and `OpenRouter Auto` compare equal. */
function normalizeModelLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves the label shown for the session's bound model.
 *
 * A model ID is only self-describing when it restates the model's name, as with
 * OpenRouter's `openrouter/auto` / `OpenRouter Auto`. Those IDs are what users
 * copy and configure, so they render verbatim. When the name carries
 * information the ID does not — the ChatGPT subscription's `codex-default` is
 * named `ChatGPT default` — the human name wins so the readout never exposes
 * transport wording. An unresolvable model falls back to the raw ID rather than
 * inventing a label.
 */
export function modelLabel(
  modelId: string | null,
  provider: AIProviderStatus | undefined
): string {
  if (!modelId) return 'Provider default';
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  if (!model) return modelId;
  return normalizeModelLabel(model.name) === normalizeModelLabel(model.id) ? model.id : model.name;
}

/**
 * Whether a session's stored model binding is the provider's own default rather
 * than a model the user picked.
 *
 * A CLI subscription publishes exactly one sentinel model whose id follows the
 * `<provider>-default` grammar — `codex-default`, `claude-default`,
 * `antigravity-default` — and the provider's argv builder treats that id as
 * "send no `--model`". An unset binding means the same thing. Naming either one
 * in a chip only restates the provider the card already reports, so the caller
 * omits the chip. This reads the binding; it never changes it.
 */
export function isProviderDefaultModel(modelId: string | null): boolean {
  return modelId === null || modelId.endsWith('-default');
}

export function defaultLocation(format: DocumentMetadata['format'], currentPage: number): DocumentLocation {
  if (format === 'pdf') return { format: 'pdf', pageIndex: Math.max(0, currentPage - 1) };
  if (format === 'docx' || format === 'pptx') return { format, paragraphIndex: 0 };
  if (format === 'markdown') return { format: 'markdown', blockIndex: 0 };
  if (format === 'mobi') return { format: 'mobi', sectionIndex: Math.max(0, currentPage - 1) };
  return { format: 'epub', cfi: 'epubcfi(/6/2!/4/1:0)' };
}

export function validatePageRange(
  startText: string,
  endText: string,
  pageCount: number | null
): string | null {
  const start = parsePageInput(startText);
  const end = parsePageInput(endText);
  if (start === null || end === null) return 'Enter whole-number start and end pages.';
  if (start < 1 || end < 1) return 'Pages must be at least 1.';
  if (pageCount !== null && (start > pageCount || end > pageCount)) {
    return `Pages must be between 1 and ${String(pageCount)} for this document.`;
  }
  if (end < start) return 'End page must be greater than or equal to start page.';
  if (end - start + 1 > CHAT_MAX_PAGE_RANGE) {
    return `Choose no more than ${String(CHAT_MAX_PAGE_RANGE)} pages at a time.`;
  }
  return null;
}

function parsePageInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Placeholder for the composer, kept as flat cases rather than nested ternaries. */
export function composerPlaceholder(input: {
  readonly discovery: ProviderDiscoveryState;
  readonly hasReadyProvider: boolean;
  readonly isArchived: boolean;
  readonly sessionPlaceholder: string;
  /**
   * Whether the thread already has turns. The general prompt changes with the
   * conversation — asking about the document before the first turn, following
   * up after it — while a passage-specific prompt keeps its own wording.
   */
  readonly hasMessages: boolean;
}): string {
  // Discovery has not answered, so "none ready" would be a guess either way:
  // one case is still being answered, the other could not be.
  if (input.discovery === 'loading') return 'Checking available AI providers…';
  if (input.discovery === 'failed') return 'Could not check AI providers. Use Check Again above, or open Settings.';
  if (!input.hasReadyProvider) return 'No AI provider is ready. Open Settings to connect OpenRouter or Claude.';
  if (input.isArchived) return 'This conversation is archived. Create a new session to ask questions.';
  if (input.sessionPlaceholder !== 'Ask a question about this document…') return input.sessionPlaceholder;
  return input.hasMessages ? 'Ask a follow up…' : 'Ask about this document…';
}
