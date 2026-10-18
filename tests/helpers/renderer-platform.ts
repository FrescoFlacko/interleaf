/**
 * The browser APIs Electron's renderer always provides and jsdom lacks.
 *
 * Production code uses them unconditionally, so every jsdom window a test
 * renders into gets them: the test setup installs them on the top window, and
 * a case that paints inside an iframe can install them on that frame's window.
 * Nothing here lays anything out, so the observers never report on their own;
 * a case that drives one replaces it with a double that calls the production
 * callback.
 */
export function installRendererPlatform(view: Window & typeof globalThis): void {
  defineValue(view, 'ResizeObserver', InertResizeObserver);
  defineValue(view, 'IntersectionObserver', InertIntersectionObserver);
  defineValue(view, 'Highlight', TestHighlight);
  defineValue(view, 'matchMedia', noPreferenceMediaQuery);
  defineValue(view.Element.prototype, 'scrollIntoView', scrollWithoutLayout);
  const registry: HighlightRegistry = new Map<string, Highlight>();
  if (Reflect.has(view, 'CSS')) {
    defineValue(view.CSS, 'highlights', registry);
  } else {
    defineValue(view, 'CSS', { highlights: registry });
  }
}

/**
 * Ebook sections render in iframes whose windows Electron equips like the top
 * one, so each frame window gets the platform the first time a frame's window
 * or document is reached through the element.
 */
export function installFramePlatform(view: Window & typeof globalThis): void {
  const equipped = new WeakSet<Window>();
  const proto = view.HTMLIFrameElement.prototype;
  const windowGetter = requireGetter(proto, 'contentWindow');
  const documentGetter = requireGetter(proto, 'contentDocument');
  const equip = (frameWindow: Window | null): void => {
    if (frameWindow === null || equipped.has(frameWindow)) return;
    equipped.add(frameWindow);
    installRendererPlatform(frameWindow as Window & typeof globalThis);
  };
  Object.defineProperty(proto, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement): Window | null {
      const frameWindow = windowGetter.call(this);
      equip(frameWindow);
      return frameWindow;
    },
  });
  Object.defineProperty(proto, 'contentDocument', {
    configurable: true,
    get(this: HTMLIFrameElement): Document | null {
      equip(windowGetter.call(this));
      return documentGetter.call(this);
    },
  });
}

/** jsdom defines both frame accessors as prototype getters. */
function requireGetter<K extends 'contentWindow' | 'contentDocument'>(
  proto: HTMLIFrameElement,
  key: K,
): (this: HTMLIFrameElement) => HTMLIFrameElement[K] {
  const getter = Object.getOwnPropertyDescriptor(proto, key)?.get;
  if (getter === undefined) throw new Error(`HTMLIFrameElement.${key} has no getter`);
  return getter as (this: HTMLIFrameElement) => HTMLIFrameElement[K];
}

/** Everything this module installs on a window or its `CSS` namespace. */
type PlatformValue =
  | typeof ResizeObserver
  | typeof IntersectionObserver
  | typeof Highlight
  | typeof matchMedia
  | Element['scrollIntoView']
  | HighlightRegistry
  | { readonly highlights: HighlightRegistry };

function defineValue(target: object, key: string, value: PlatformValue): void {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

class InertResizeObserver implements ResizeObserver {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

class InertIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px 0px 0px 0px';
  readonly thresholds: readonly number[];

  constructor(_callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px 0px 0px 0px';
    const threshold = options.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
  }

  observe(): void {
    return undefined;
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

/** The set-like `Highlight` Chromium implements. */
class TestHighlight extends Set<AbstractRange> implements Highlight {
  priority = 0;
  type: HighlightType = 'highlight';

  constructor(...ranges: AbstractRange[]) {
    super(ranges);
  }

  override forEach(
    callback: (value: AbstractRange, key: AbstractRange, parent: Highlight) => void,
    thisArg?: object,
  ): void {
    super.forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }
}

/** With no layout there is nothing to scroll; the request itself is the effect. */
function scrollWithoutLayout(): void {
  return undefined;
}

/** A window whose user states no media preference, as a default desktop does. */
function noPreferenceMediaQuery(query: string): MediaQueryList {
  const base: Omit<MediaQueryList, 'matches'> = {
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
  return Object.assign(base, { matches: false });
}
