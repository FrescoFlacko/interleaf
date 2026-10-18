import { DEFAULT_HIGHLIGHT_RGBA } from '@shared/constants/annotations';

// Overlayer custom element ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

const SVG_NS = 'http://www.w3.org/2000/svg';

const createSVGElement = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag);

/** Style inputs the draw functions accept. */
export type OverlayDrawOptions = { readonly color?: string | undefined; readonly width?: number | undefined };

export type DrawFunction = (rects: DOMRectList | DOMRect[], options?: OverlayDrawOptions) => SVGElement;

export type OverlayItem = {
  range: Range | ((root: Node) => Range);
  draw: DrawFunction;
  options?: OverlayDrawOptions | undefined;
  element: SVGElement;
  rects: DOMRectList | DOMRect[];
};

export class Overlayer extends HTMLElement {
  private readonly svg = createSVGElement('svg');
  private readonly map = new Map<string, OverlayItem>();

  constructor() {
    super();
    Object.assign(this.svg.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    this.append(this.svg);
  }

  get element(): SVGSVGElement {
    return this.svg;
  }

  add(key: string, range: Range | ((root: Node) => Range), draw: DrawFunction, options?: OverlayDrawOptions): void {
    if (this.map.has(key)) this.removeItem(key);
    const resolvedRange = typeof range === 'function' ? range(this.svg.getRootNode()) : range;
    const rects = resolvedRange.getClientRects();
    const element = draw(rects, options);
    this.svg.append(element);
    const item: OverlayItem = { range, draw, element, rects, ...(options ? { options } : {}) };
    this.map.set(key, item);
  }

  removeItem(key: string): void {
    const item = this.map.get(key);
    if (!item) return;
    item.element.remove();
    this.map.delete(key);
  }

  clear(): void {
    while (this.svg.firstChild) {
      this.svg.removeChild(this.svg.firstChild);
    }
    this.map.clear();
  }

  redraw(): void {
    for (const [key, obj] of this.map.entries()) {
      const range = typeof obj.range === 'function' ? obj.range(this.svg.getRootNode()) : obj.range;
      const rects = range.getClientRects();
      const element = obj.draw(rects, obj.options);
      obj.element.replaceWith(element);
      obj.element = element;
      obj.rects = rects;
      this.map.set(key, obj);
    }
  }

  static highlight(rects: DOMRectList | DOMRect[], options: { color?: string } = {}): SVGElement {
    const g = createSVGElement('g');
    g.setAttribute('fill', options.color ?? DEFAULT_HIGHLIGHT_RGBA);
    for (const rect of Array.from(rects)) {
      const r = createSVGElement('rect');
      r.setAttribute('x', String(rect.left));
      r.setAttribute('y', String(rect.top));
      r.setAttribute('width', String(rect.width));
      r.setAttribute('height', String(rect.height));
      g.append(r);
    }
    return g;
  }

  static underline(rects: DOMRectList | DOMRect[], options: { color?: string; width?: number } = {}): SVGElement {
    const g = createSVGElement('g');
    g.setAttribute('stroke', options.color ?? 'currentColor');
    g.setAttribute('stroke-width', String(options.width ?? 2));
    for (const rect of Array.from(rects)) {
      const line = createSVGElement('line');
      line.setAttribute('x1', String(rect.left));
      line.setAttribute('y1', String(rect.bottom));
      line.setAttribute('x2', String(rect.right));
      line.setAttribute('y2', String(rect.bottom));
      g.append(line);
    }
    return g;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('foliate-overlayer')) {
  customElements.define('foliate-overlayer', Overlayer);
}
