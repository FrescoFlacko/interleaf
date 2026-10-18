import type { HTMLAttributes, ReactElement, Ref } from 'react';
import { cn } from './cn';

type ScrollAreaProps = HTMLAttributes<HTMLDivElement> & {
  readonly viewportRef?: Ref<HTMLDivElement>;
};

/**
 * shadcn-shaped scroll area over the platform scroller rather than a custom
 * one, so scroll position, wheel physics and keyboard scrolling stay native.
 * `min-h-0` is part of the primitive because a flex child otherwise refuses to
 * shrink and the region scrolls its parent instead of itself. Its own children
 * are held at their natural height for the mirror-image reason: when the
 * viewport is itself a flex column, flex would otherwise compress the content
 * to fit and clip it instead of letting the region scroll.
 */
export function ScrollArea({ className, viewportRef, ...props }: ScrollAreaProps): ReactElement {
  return (
    <div
      ref={viewportRef}
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain [&>*]:shrink-0', className)}
      {...props}
    />
  );
}
