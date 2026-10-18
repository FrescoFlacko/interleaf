import { type PortableRecord, type PortableValue, isPortableArray } from '@shared/models/portable';

const MAX_CITATION_TITLE_LENGTH = 120;
const MAX_CITATION_URL_LENGTH = 2_048;

/** One `url_citation` annotation, already validated and safe to render. */
export type OpenRouterCitation = {
  readonly url: string;
  readonly title: string;
};

export const NO_CITATIONS: readonly OpenRouterCitation[] = [];

/**
 * Reads OpenRouter's standardized streamed citation annotations off one delta.
 *
 * These are the provider's own record of what its hosted search actually
 * retrieved, so they are the only authoritative account of where a web-backed
 * answer came from; dropping them would leave the claim unattributable.
 * Anything that is not a well-formed `url_citation` with a safe URL is ignored
 * rather than guessed at.
 * https://openrouter.ai/docs/guides/features/server-tools/web-search
 */
export function parseCitationAnnotations(delta: PortableRecord): readonly OpenRouterCitation[] {
  if (!isPortableArray(delta.annotations)) return NO_CITATIONS;
  const citations: OpenRouterCitation[] = [];
  for (const annotation of delta.annotations) {
    const citation = parseUrlCitation(annotation);
    if (citation !== null) citations.push(citation);
  }
  return citations;
}

function parseUrlCitation(annotation: PortableValue): OpenRouterCitation | null {
  if (typeof annotation !== 'object' || annotation === null) return null;
  if (!('type' in annotation) || annotation.type !== 'url_citation') return null;
  if (!('url_citation' in annotation)) return null;
  const detail: PortableValue = annotation.url_citation;
  if (typeof detail !== 'object' || detail === null || !('url' in detail)) return null;
  const url = parseCitationUrl(detail.url);
  if (url === null) return null;
  const rawTitle = 'title' in detail && typeof detail.title === 'string' ? detail.title : '';
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, MAX_CITATION_TITLE_LENGTH);
  // No Markdown escaping is applied to either field: they are carried as
  // structured metadata and never assembled into assistant text, so the URL
  // stays byte-faithful and the title stays plain text.
  return { url: url.href, title: title.length > 0 ? title : url.host };
}

/** Length-bounded absolute http(s) URLs only; anything else is not a source. */
function parseCitationUrl(raw: PortableValue): URL | null {
  if (typeof raw !== 'string' || raw.length > MAX_CITATION_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}
