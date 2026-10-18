import { chatWebSourceSchema } from '@shared/schemas/chat-wire';
import type { ChatWebSource } from '@shared/types/ai';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';

/**
 * Storage codec for the provider-hosted web sources attached to one assistant
 * message.
 *
 * They live in their own column instead of inside `content` because `content`
 * is the model-authored transcript that later turns replay to the model under
 * the `assistant` role; an untrusted webpage title must never reach it. Keeping
 * the codec here also keeps the repository's own branch count unchanged.
 */
export function serializeWebSources(
  sources: readonly ChatWebSource[] | undefined
): string | null {
  return sources && sources.length > 0 ? JSON.stringify(sources) : null;
}

/**
 * The `webSources` of a mapped message; empty when the column is NULL (no
 * sources, or a row written before the column existed).
 *
 * Parsing is fail-soft, matching how disclosures are read back: a corrupt or
 * outdated metadata blob costs the reader an attribution list, and must not
 * cost them the answer it was attached to.
 */
export function parseWebSources(json: string | null): ChatWebSource[] {
  if (json === null) return [];
  try {
    const raw: PortableValue = parsePortableJson(json);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => chatWebSourceSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => result.data);
  } catch {
    return [];
  }
}
