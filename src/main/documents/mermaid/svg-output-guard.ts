/**
 * Main's authoritative check on the markup an isolated renderer produced.
 *
 * The isolated window already rebuilds the drawing from an element/attribute
 * allow-list, but that process is the one that executed the diagram library
 * over document-supplied input, so its word is not the decision. This guard is
 * a lexical scan — it parses nothing — run in main over the serialized result,
 * and it refuses rather than repairs: a drawing that trips any rule is
 * discarded and the reader sees the fenced source instead.
 *
 * It is the second of three layers. The third is the display context: the
 * renderer paints the result as an image, where script, external fetches, and
 * DOM access do not exist even for markup that reached it.
 */

export type SvgGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: string };

/** Elements that can execute, embed, fetch, or escape into HTML. */
const FORBIDDEN_ELEMENTS = [
  'script',
  'foreignobject',
  'iframe',
  'frame',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'form',
  'input',
  'button',
  'textarea',
  'animate',
  'animatetransform',
  'animatemotion',
  'set',
  'handler',
  'listener',
  'image',
  'feimage',
  'use',
  'a',
] as const;

/** Anything that names a resource or a navigation target. */
const FORBIDDEN_ATTRIBUTES = [
  'href',
  'xlink:href',
  'src',
  'srcset',
  'formaction',
  'action',
  'ping',
  'xlink:actuate',
  'xlink:show',
  'externalresourcesrequired',
] as const;

function violation(rule: string): SvgGuardVerdict {
  return { ok: false, violation: rule };
}

/**
 * True when `markup` contains a start tag for any listed element name.
 *
 * Matching is on the tag name that follows `<` or `</`, so an element name
 * appearing inside ordinary text or an attribute value is not a hit, while
 * `<SCRIPT`, `<svg:script`, and `< script` are.
 */
function containsElement(lowered: string, names: readonly string[]): string | null {
  const tagPattern = /<\s*\/?\s*(?:[a-z0-9_-]+:)?([a-z0-9_-]+)/g;
  let match = tagPattern.exec(lowered);
  while (match !== null) {
    const name = match[1] ?? '';
    if (names.includes(name)) return name;
    match = tagPattern.exec(lowered);
  }
  return null;
}

/** True when an attribute with one of these names is assigned anywhere. */
function containsAttribute(lowered: string, names: readonly string[]): string | null {
  const attributePattern = /[\s"'/]([a-z_:][a-z0-9_:.-]*)\s*=/g;
  let match = attributePattern.exec(lowered);
  while (match !== null) {
    const name = match[1] ?? '';
    if (names.includes(name)) return name;
    if (name.startsWith('on')) return name;
    match = attributePattern.exec(lowered);
  }
  return null;
}

export type SvgGuardOptions = {
  readonly maxLength: number;
};

/**
 * Accepts only a self-contained, inert `<svg>` document.
 *
 * The rules are deliberately blunt. `<use>`, `<image>` and `<a>` are refused
 * outright even though a same-document `#id` form exists, because a reference
 * that is safe in one serializer is a fetch in another, and a diagram has no
 * need of any of them.
 */
export function assertInertSvg(markup: string, options: SvgGuardOptions): SvgGuardVerdict {
  if (markup.length === 0) return violation('empty');
  if (markup.length > options.maxLength) return violation('too-large');

  const lowered = markup.trim().toLowerCase();

  // A drawing is one SVG document and nothing else: no prolog, no doctype, no
  // entity declarations, no processing instructions, no comments.
  if (lowered.includes('<!doctype')) return violation('doctype');
  if (lowered.includes('<!entity') || lowered.includes('<!attlist') || lowered.includes('<!element')) {
    return violation('dtd-declaration');
  }
  if (lowered.includes('<?')) return violation('processing-instruction');
  if (lowered.includes('<!--')) return violation('comment');
  if (lowered.includes(']]>')) return violation('cdata');

  if (!lowered.startsWith('<svg')) return violation('not-svg-root');
  if (!lowered.endsWith('</svg>')) return violation('not-svg-root');

  const forbiddenElement = containsElement(lowered, FORBIDDEN_ELEMENTS);
  if (forbiddenElement !== null) return violation(`element:${forbiddenElement}`);

  const forbiddenAttribute = containsAttribute(lowered, FORBIDDEN_ATTRIBUTES);
  if (forbiddenAttribute !== null) return violation(`attribute:${forbiddenAttribute}`);

  // Scheme and resource references, wherever they were spelled.
  if (/javascript\s*:/.test(lowered)) return violation('javascript-url');
  if (/vbscript\s*:/.test(lowered)) return violation('vbscript-url');
  if (lowered.includes('data:text/html')) return violation('data-html-url');
  if (lowered.includes('data:image/svg')) return violation('nested-svg-url');
  // `url(#id)` is how an arrowhead names a marker defined in the same drawing.
  // A fragment reference resolves inside the document and fetches nothing; any
  // other `url(...)` names something outside it and is refused.
  if (/url\s*\(\s*(?!['"]?#[a-z0-9_:.-]+['"]?\s*\))/.test(lowered)) return violation('css-url');
  if (lowered.includes('@import')) return violation('css-import');
  if (lowered.includes('expression(')) return violation('css-expression');
  if (lowered.includes('-moz-binding')) return violation('css-binding');
  // Character references are how a refused string is smuggled past a scan that
  // reads bytes. The XML built-ins and the numeric forms a serializer emits for
  // ordinary label text are the only ones a drawing needs.
  if (/&(?!(?:amp;|lt;|gt;|quot;|apos;|nbsp;|#\d{1,7};|#x[0-9a-f]{1,6};))/.test(lowered)) {
    return violation('entity-reference');
  }
  if (lowered.includes('http://') || lowered.includes('https://')) {
    // The SVG and xlink namespace declarations are the only absolute URLs a
    // serialized drawing needs, and they are namespace names, not fetches.
    const remaining = lowered
      .replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
      .replace(/http:\/\/www\.w3\.org\/1999\/xlink/g, '')
      .replace(/http:\/\/www\.w3\.org\/1999\/xhtml/g, '')
      .replace(/http:\/\/www\.w3\.org\/xml\/1998\/namespace/g, '');
    if (remaining.includes('http://') || remaining.includes('https://')) {
      return violation('remote-url');
    }
  }
  if (/(?:^|["'\s(=])\/\/[a-z0-9]/.test(lowered)) return violation('protocol-relative-url');

  return { ok: true };
}
