import type { ComponentProps, ReactElement } from 'react';
import { cn } from '../ui/cn';

/**
 * A suggested next prompt, shared by Reader Chat and Agent Mode. Choosing it
 * only fills the field; nothing is sent or started.
 */
export function FollowUpChip({ className, type = 'button', ...props }: ComponentProps<'button'>): ReactElement {
  return <button type={type} className={cn('companion-follow-up', className)} {...props} />;
}
