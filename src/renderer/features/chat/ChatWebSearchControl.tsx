import { AppIcon } from '../../components/AppIcon';

/** The per-turn web-search opt-in. */

type ChatWebSearchToggleProps = {
  /**
   * Whether the bound provider itself declares the hosted web-search path.
   */
  readonly supported: boolean;
  /** Per-turn opt-in state. Off unless the user turned it on for this turn. */
  readonly enabled: boolean;
  readonly providerReady: boolean;
  readonly controlsDisabled: boolean;
  readonly onChange: (enabled: boolean) => void;
};

/**
 * The control is a glyph alone. Its name is carried by `aria-label` rather than
 * visible text, so assistive technology still announces one unambiguous name
 * and a pressed state, while the composer's control row keeps the width a
 * narrow or zoomed panel needs for the provider and model menus.
 */
const WEB_SEARCH_LABEL = 'Web search';

export function ChatWebSearchToggle({
  supported,
  enabled,
  providerReady,
  controlsDisabled,
  onChange,
}: ChatWebSearchToggleProps) {
  if (!supported) return null;
  return (
    <button
      type="button"
      data-testid="chat-web-search-toggle"
      aria-pressed={enabled}
      aria-label={WEB_SEARCH_LABEL}
      title={WEB_SEARCH_LABEL}
      disabled={!providerReady || controlsDisabled}
      onClick={() => { onChange(!enabled); }}
      className={
        'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40 ' +
        (enabled
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border-subtle text-text-secondary hover:text-text-primary')
      }
    >
      <AppIcon name="web-search" size={14} />
    </button>
  );
}
