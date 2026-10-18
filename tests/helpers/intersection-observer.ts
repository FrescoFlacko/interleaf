/**
 * One complete observer record.
 *
 * jsdom has no `IntersectionObserver`, so a test that drives virtualization
 * calls the production callback itself with records it builds here. Only the
 * target and whether it intersects are usually interesting; the rest of the
 * record is derived from the target's own geometry so the values agree with
 * what the DOM would have reported.
 */
export function testIntersectionObserverEntry(options: {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly boundingClientRect?: DOMRectReadOnly;
  readonly intersectionRect?: DOMRectReadOnly;
  readonly rootBounds?: DOMRectReadOnly | null;
  readonly intersectionRatio?: number;
  readonly time?: number;
}): IntersectionObserverEntry {
  const bounds = options.boundingClientRect ?? options.target.getBoundingClientRect();
  return {
    target: options.target,
    isIntersecting: options.isIntersecting,
    boundingClientRect: bounds,
    intersectionRect: options.intersectionRect ?? (options.isIntersecting ? bounds : new DOMRect()),
    rootBounds: options.rootBounds ?? null,
    intersectionRatio: options.intersectionRatio ?? (options.isIntersecting ? 1 : 0),
    time: options.time ?? 0,
  };
}

/**
 * An observer whose every target is on screen, as a card in the visible part
 * of the library is. It reports each target as intersecting as soon as it is
 * observed.
 */
export class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '0px 0px 0px 0px';
  readonly scrollMargin = '0px 0px 0px 0px';
  readonly thresholds: readonly number[] = [0];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback([testIntersectionObserverEntry({ isIntersecting: true, target })], this);
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
