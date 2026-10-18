import type { NoteFocusProxy } from '../annotations/use-note-pointer';

type ReaderFocusProxiesProps = {
  readonly proxies: readonly NoteFocusProxy[];
  /** `data-testid` prefix; the annotation id completes it. */
  readonly testIdPrefix: string;
  /** Accessible-name prefix; the untrusted text preview completes it as plain text. */
  readonly labelPrefix: string;
  readonly onActivate: (annotationId: string, opener: Element) => void;
};

/**
 * Keyboard activation routes over painted reader text: focusable, invisible
 * buttons laid over each annotation's live fragment geometry in the top
 * document. Notes and saved highlights each render one list.
 */
export function ReaderFocusProxies({ proxies, testIdPrefix, labelPrefix, onActivate }: ReaderFocusProxiesProps) {
  return proxies.map((proxy) => (
    <button
      key={proxy.annotationId}
      type="button"
      data-testid={`${testIdPrefix}-${proxy.annotationId}`}
      aria-label={`${labelPrefix}: ${proxy.label}`}
      onClick={(event) => {
        // Keyboard activation (Enter/Space on a focused proxy). A native
        // click here must not also reach the surface controller's
        // outside-click close for the popover this opens. Pointer events
        // are disabled on the proxy so it never blocks text selection or
        // direct pointer activation of the underlying painted range.
        event.stopPropagation();
        onActivate(proxy.annotationId, event.currentTarget);
      }}
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        left: proxy.rect.left,
        top: proxy.rect.top,
        width: Math.max(proxy.rect.right - proxy.rect.left, 8),
        height: Math.max(proxy.rect.bottom - proxy.rect.top, 8),
      }}
      className="pointer-events-none fixed z-20 rounded-sm bg-transparent outline-none focus-visible:bg-accent/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    />
  ));
}
