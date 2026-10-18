import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from './cn';

/**
 * shadcn-shaped card: the 12 px card radius and a hairline border; colour
 * comes from the semantic theme tokens so every palette keeps working.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn('rounded-lg border border-border-subtle bg-bg-primary', className)} {...props} />;
}

/** Header strip closed by a hairline, as on the reference RUN SETTINGS card. */
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      className={cn('flex items-center justify-between gap-2 border-b border-border-subtle px-4 pt-3 pb-2', className)}
      {...props}
    />
  );
}

/** Tinted footer strip; the reference attaches the context controls here. */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-t border-border-subtle bg-bg-surface px-3 py-2', className)}
      {...props}
    />
  );
}

/**
 * A card's sentence-case section label ("Task", "Run settings"), rendered as
 * text rather than a heading unless the caller passes one, so it never
 * distorts the heading outline.
 */
export function CardLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>): ReactElement {
  return (
    <span
      className={cn('text-xs font-medium text-text-secondary', className)}
      {...props}
    />
  );
}
