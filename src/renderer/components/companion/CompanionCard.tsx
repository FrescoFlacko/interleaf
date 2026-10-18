import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from '../ui/cn';

/**
 * A card in the companion panel: 12px radius, hairline border, and a body
 * padded 12px by 16px. Reader Chat conversation cards and Agent cards share
 * it so the two modes keep one card shape.
 */
export function CompanionCard({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn('companion-card', className)} {...props} />;
}

/** The padded content area of a `CompanionCard`. */
export function CompanionCardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn('companion-card-body', className)} {...props} />;
}
