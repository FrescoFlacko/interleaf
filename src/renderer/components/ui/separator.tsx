import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from './cn';

type SeparatorProps = HTMLAttributes<HTMLDivElement> & {
  readonly orientation?: 'horizontal' | 'vertical';
};

/**
 * shadcn-shaped separator. Decorative by default, so assistive technology is
 * not asked to announce the reference's hairlines.
 */
export function Separator({ className, orientation = 'horizontal', ...props }: SeparatorProps): ReactElement {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-hidden="true"
      className={cn(
        'shrink-0 bg-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className
      )}
      {...props}
    />
  );
}
