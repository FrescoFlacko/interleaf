/**
 * Rebuilds a rendered diagram from an allow-list.
 *
 * The drawing that comes out of the diagram library is not edited here — it is
 * copied. A fresh tree is constructed containing only elements and attributes
 * on these lists, with values that match the shapes listed below, so anything
 * the library emitted for a reason this code does not recognize is left behind
 * rather than inspected and kept. Addition is a deliberate act; nothing arrives
 * by default.
 *
 * This runs inside the isolated renderer, which is also the process that just
 * executed a parser over document-controlled input. It is therefore the first
 * of the output defenses and not the trusted one: main re-scans the serialized
 * result, and the reader displays it in an image context.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Elements a diagram is allowed to be made of. */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'marker',
  'path',
  'line',
  'polyline',
  'polygon',
  'rect',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'title',
  'desc',
  'style',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
]);

/**
 * Elements that are dropped while their children are kept.
 *
 * `a` is the one that matters: a diagram that declares a click target still
 * draws its shape and its label, it simply has no link. Unwrapping rather than
 * refusing is what keeps a hostile `click` directive from costing the reader
 * the whole picture.
 */
const UNWRAPPED_ELEMENTS = new Set(['a', 'switch']);

/** Attributes carried over, matched exactly — SVG names are case-sensitive. */
const ALLOWED_ATTRIBUTES = new Set([
  'id',
  'class',
  'transform',
  'd',
  'x',
  'y',
  'dx',
  'dy',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'viewBox',
  'preserveAspectRatio',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'visibility',
  'display',
  'overflow',
  'vector-effect',
  'shape-rendering',
  'text-rendering',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'word-spacing',
  'white-space',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'clip-path',
  'clipPathUnits',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-roledescription',
  'aria-hidden',
  'style',
]);

/** A same-document reference and nothing else. */
const FRAGMENT_REFERENCE = /^url\(\s*['"]?#[A-Za-z0-9_:.-]+['"]?\s*\)$/;

/** Tokens that mean a value is doing something other than describing a shape. */
const HOSTILE_VALUE = /javascript\s*:|vbscript\s*:|data\s*:|expression\s*\(|@import|-moz-binding|<|&#/i;

export class SvgSanitizeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SvgSanitizeError';
  }
}

function isSafeValue(name: string, value: string): boolean {
  if (HOSTILE_VALUE.test(value)) return false;
  if (/url\s*\(/i.test(value)) return FRAGMENT_REFERENCE.test(value.trim());
  if (name === 'style') {
    // Inline style is kept for the library's own fills and strokes, never for
    // anything that can load or execute.
    return !/[{}]|behavior|binding/i.test(value);
  }
  return true;
}

/**
 * Validates the library's own stylesheet.
 *
 * Mermaid emits its theme as a `<style>` element inside the drawing, so keeping
 * it is what makes the picture legible. Its text is checked as a whole rather
 * than parsed: a stylesheet that names any external resource, imports, or
 * reaches outside the drawing fails the render instead of being repaired.
 */
function assertSafeStylesheet(css: string): void {
  if (HOSTILE_VALUE.test(css)) throw new SvgSanitizeError('stylesheet-token');
  const urls = css.match(/url\s*\([^)]*\)/gi) ?? [];
  for (const url of urls) {
    if (!FRAGMENT_REFERENCE.test(url.trim())) throw new SvgSanitizeError('stylesheet-url');
  }
}

function copyAttributes(source: Element, target: Element): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name;
    // Namespaced attributes are dropped wholesale: `xlink:href` is the only one
    // a diagram would carry, and it is a reference this drawing must not have.
    if (name.includes(':')) continue;
    if (name.startsWith('on')) continue;
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    if (!isSafeValue(name, attribute.value)) continue;
    target.setAttribute(name, attribute.value);
  }
}

function localNameOf(element: Element): string {
  return element.localName;
}

/** Depth bound: a diagram this deeply nested is a complexity attack, not a picture. */
const MAX_DEPTH = 64;

function rebuild(source: Element, out: Document, depth: number): Node[] {
  if (depth > MAX_DEPTH) throw new SvgSanitizeError('depth');
  const name = localNameOf(source);

  if (UNWRAPPED_ELEMENTS.has(name)) {
    return rebuildChildren(source, out, depth);
  }
  if (!ALLOWED_ELEMENTS.has(name)) return [];

  const element = out.createElementNS(SVG_NAMESPACE, name);
  copyAttributes(source, element);

  if (name === 'style') {
    const css = source.textContent;
    assertSafeStylesheet(css);
    element.textContent = css;
    return [element];
  }

  for (const child of rebuildChildren(source, out, depth)) element.appendChild(child);
  return [element];
}

function rebuildChildren(source: Element, out: Document, depth: number): Node[] {
  const result: Node[] = [];
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      result.push(out.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    result.push(...rebuild(child as Element, out, depth + 1));
  }
  return result;
}

export type SanitizedSvg = {
  readonly markup: string;
  readonly width: number;
  readonly height: number;
};

function readViewBox(root: Element): { width: number; height: number } | null {
  const raw = root.getAttribute('viewBox');
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/u).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [, , width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Turns rendered markup into an inert drawing plus its intrinsic size.
 *
 * The size comes from the `viewBox` the layout engine computed, and it is put
 * back on the root as explicit `width`/`height` so the reader can reserve the
 * right box before the picture paints and show it at its natural readable size
 * rather than stretched to whatever container it lands in.
 */
export function sanitizeRenderedSvg(markup: string, maxDimension: number): SanitizedSvg {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length > 0) {
    throw new SvgSanitizeError('unparseable');
  }
  const sourceRoot = parsed.documentElement;
  if (localNameOf(sourceRoot) !== 'svg') throw new SvgSanitizeError('not-svg-root');

  const box = readViewBox(sourceRoot);
  if (box === null) throw new SvgSanitizeError('no-viewbox');
  if (box.width > maxDimension || box.height > maxDimension) {
    throw new SvgSanitizeError('dimensions');
  }

  const out = document.implementation.createDocument(SVG_NAMESPACE, 'svg', null);
  const root = out.documentElement;
  copyAttributes(sourceRoot, root);
  // The library's root carries a `max-width` style that would override the
  // reader's own layout; the drawing's size is Interleaf's decision.
  root.removeAttribute('style');
  root.setAttribute('width', String(Math.ceil(box.width)));
  root.setAttribute('height', String(Math.ceil(box.height)));
  for (const child of rebuildChildren(sourceRoot, out, 1)) root.appendChild(child);

  return {
    markup: new XMLSerializer().serializeToString(root),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };
}
