import type { ReactNode } from 'react';

type LoadingShimmerTextProps = {
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * Pending-text treatment shared by the Library and Chat loading states.
 *
 * The element only carries the shimmer class: the styling, the palette tokens
 * and the `prefers-reduced-motion` fallback all live in `global.css`. The text
 * stays a normal text node inside whatever `role="status"` container the caller
 * already renders, so assistive technology reads exactly what it read before.
 */
export function LoadingShimmerText({ children, className }: LoadingShimmerTextProps) {
  return (
    <span data-loading-shimmer="true" className={`ml-loading-shimmer ${className ?? ''}`.trimEnd()}>
      {children}
    </span>
  );
}
