import * as pdfjsLib from 'pdfjs-dist';
import type { QuoteContext } from '@shared/types/annotation';
import type { PortableValue } from '@shared/models/portable';
import {
  resolveTextAnchor,
  type ResolveTextAnchorOptions,
  type TextAnchorResolution,
} from '../annotations/text-anchor-resolver';

/**
 * Puts text into the same character space PDF.js's normalized layer uses.
 *
 * Not `String.normalize('NFKC')`: PDF.js folds a *selective* class — ligatures,
 * a few spaces and symbols, the Arabic presentation forms — and leaves the rest
 * of the NFKC domain untouched. `"ﬀＡ"` reaches the layer as `"ffＡ"`, keeping
 * the fullwidth `Ａ` that NFKC would flatten to `"A"`. Normalizing a quote more
 * aggressively than the text it is matched against reintroduces the very
 * mismatch this path exists to close, in the opposite direction.
 *
 * The upstream declaration is `(str: any) => any`, so the result is checked
 * rather than asserted; anything other than a string leaves the text as-is and
 * the caller falls back to its original resolution.
 */
const normalizeUnicode: (value: string) => PortableValue = pdfjsLib.normalizeUnicode;

function normalizeToRenderedSpace(value: string): string {
  const normalized = normalizeUnicode(value);
  return typeof normalized === 'string' ? normalized : value;
}

function normalizeQuoteContext(quote: QuoteContext): QuoteContext {
  return {
    exact: normalizeToRenderedSpace(quote.exact),
    prefix: normalizeToRenderedSpace(quote.prefix),
    suffix: normalizeToRenderedSpace(quote.suffix),
  };
}

/**
 * Resolves a persisted PDF annotation quote against the rendered text layer,
 * with a fallback for anchors recorded in the raw glyph space.
 *
 * The rendered layer is normalized — see `PDF_TEXT_CONTENT_PARAMS`, and the
 * comment on the `builder.render` call that applies it — so U+FB00 reaches the
 * DOM as `"ff"`, never as `"ﬀ"`. An annotation captured against a raw layer
 * holds `"oﬃce"` where the DOM now says `"office"`, and {@link resolveTextAnchor}
 * cannot read it back: the native offsets are short by one per ligature and the
 * exact search finds nothing. What is left is the fuzzy stage, which sizes its
 * candidate window to the *raw* quote length — so it either scores a short
 * candidate below the threshold and reports the annotation unanchored, or
 * clears the threshold on a candidate that stops one character early and
 * anchors a highlight that visibly omits the end of its own word.
 *
 * Normalizing the quote — never the DOM — fixes both without moving the
 * character space every other anchor, search offset and indexed chunk lives in.
 * The retry is gated twice: only when normalization actually changes the quote,
 * and only when the ordinary resolution was itself uncertain, so a native or
 * exact-quote hit is never displaced and an annotation that resolves today
 * cannot move. Only a certain match displaces an existing fuzzy one; between
 * two approximations the stored quote's own reading wins. The result is still a
 * real match against the live layer text, so the fail-closed contract is
 * unchanged: a quote that describes no text on the page still resolves to
 * `null`.
 */
export async function resolvePdfAnnotationAnchor(
  layerText: string,
  quote: QuoteContext,
  options: ResolveTextAnchorOptions
): Promise<TextAnchorResolution | null> {
  const resolution = await resolveTextAnchor(layerText, quote, options);
  if (resolution && resolution.stage !== 'fuzzy') return resolution;

  const normalized = normalizeQuoteContext(quote);
  if (normalized.exact === quote.exact) return resolution;
  // The stored native offsets count raw glyphs, so they cannot describe the
  // normalized quote; the retry matches on quote and context alone.
  const recovered = await resolveTextAnchor(layerText, normalized, {
    ...(options.priorOffset !== undefined ? { priorOffset: options.priorOffset } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!recovered) return resolution;
  if (resolution && recovered.stage === 'fuzzy') return resolution;
  return recovered;
}
