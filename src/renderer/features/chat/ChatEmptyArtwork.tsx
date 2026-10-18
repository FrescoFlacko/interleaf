import { AppIcon } from '../../components/AppIcon';

/**
 * Decorative mark for the empty chat thread: a document card with a chat badge.
 *
 * Everything is drawn from semantic tokens (`currentColor` plus the surface and
 * border tokens), so it re-tints in all six palettes instead of carrying its own
 * colours. It is purely illustrative and adds nothing to the accessible name of
 * the empty state, so the whole composition is `aria-hidden`.
 */
export function ChatEmptyArtwork() {
  return (
    <span
      aria-hidden="true"
      data-testid="chat-empty-artwork"
      className="relative mb-3 inline-flex h-14 w-12 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-text-secondary"
    >
      <svg width="22" height="26" viewBox="0 0 22 26" fill="none" focusable="false">
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55">
          <path d="M3 5h16" />
          <path d="M3 10h16" />
          <path d="M3 15h11" />
        </g>
      </svg>
      <span className="absolute -bottom-2 -right-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle bg-bg-surface-elevated text-accent">
        <AppIcon name="chat-thread" size={13} />
      </span>
    </span>
  );
}
