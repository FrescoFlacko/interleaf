import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from '../ui/cn';

type ComposerShellProps = HTMLAttributes<HTMLDivElement> & {
  /** `none` when the composer lays out its own header and footer strips. */
  readonly padding?: 'default' | 'none' | undefined;
};

/**
 * The frame around a companion prompt: its field, controls and primary
 * action. Reader Chat's composer and the Agent task and resume composers all
 * use it, so focus, radius and spacing are the same in both modes.
 */
export function ComposerShell({ className, padding = 'default', ...props }: ComposerShellProps): ReactElement {
  return <div data-padding={padding} className={cn('companion-composer', className)} {...props} />;
}
