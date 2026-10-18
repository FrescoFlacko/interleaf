import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn';

type CollapsibleProps = {
  /**
   * Rendered inside the trigger button. Receives the current state so a caller
   * can swap its label, as the reference does with `Show` / `Hide`.
   */
  readonly trigger: (expanded: boolean) => ReactNode;
  /** Accessible name for the trigger when its visible text is not enough. */
  readonly triggerLabel?: string;
  readonly triggerClassName?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly defaultExpanded?: boolean;
  readonly children: ReactNode;
};

/**
 * shadcn-shaped collapsible implemented with the plain ARIA disclosure pattern
 * instead of Radix. The content element stays mounted and is hidden with the
 * `hidden` attribute, so `aria-controls` always resolves to a real element and
 * the collapsed text is still reachable by find-in-page.
 */
export function Collapsible({
  trigger,
  triggerLabel,
  triggerClassName,
  className,
  contentClassName,
  defaultExpanded = false,
  children,
}: CollapsibleProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const regionId = useId();

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        {...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel })}
        onClick={() => { setExpanded((current) => !current); }}
        className={cn(
          'rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          triggerClassName
        )}
      >
        {trigger(expanded)}
      </button>
      <div id={regionId} hidden={!expanded} className={contentClassName}>
        {children}
      </div>
    </div>
  );
}
