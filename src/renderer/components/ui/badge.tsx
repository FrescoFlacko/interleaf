import type { HTMLAttributes, ReactElement } from 'react';
import { cn, variants, type VariantProps } from './cn';

const badgeVariants = variants(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm',
  {
    variants: {
      tone: {
        neutral: 'bg-bg-surface text-text-secondary',
        outline: 'border border-border-subtle text-text-secondary',
        success: 'bg-success/10 text-success',
        danger: 'border border-danger/30 text-danger',
        accent: 'border border-accent/20 bg-accent/10 text-accent',
        warning: 'bg-warning/10 text-warning',
      },
      size: {
        /** Status pill: 2px/8px, 11px text. */
        pill: 'px-2 py-0.5 text-2xs font-medium',
        /** Compact chip for codes and states: EXIT 0, MODIFIED, SANDBOXED. */
        mono: 'px-1.5 py-0.5 font-mono text-2xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'mono' },
  }
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<{
    tone: Record<'neutral' | 'outline' | 'success' | 'danger' | 'accent' | 'warning', string>;
    size: Record<'pill' | 'mono', string>;
  }>;

/** shadcn-shaped badge, covering the reference's status pills and mono chips. */
export function Badge({ className, tone, size, ...props }: BadgeProps): ReactElement {
  return <span className={badgeVariants({ tone, size, className })} {...props} />;
}

/** The 6 px status dot the reference pairs with a pill or a timeline label. */
export function BadgeDot({ className, ...props }: HTMLAttributes<HTMLSpanElement>): ReactElement {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-current', className)} {...props} />;
}
