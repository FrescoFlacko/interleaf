import type { ReactElement, ReactNode } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Collapsible } from '../../components/ui/collapsible';

/**
 * A closed-by-default disclosure for the diagnostics panel's details. It opens
 * instantly, so there is no motion to reduce, and its content stays mounted so
 * find-in-page still reaches it.
 */
export function DiagnosticsDisclosure({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <Collapsible
      className="flex min-w-0 flex-col gap-2"
      triggerClassName="flex items-center gap-1 self-start text-xs font-medium text-text-primary hover:text-accent"
      contentClassName="flex min-w-0 flex-col gap-2"
      trigger={(expanded) => (
        <>
          <AppIcon name={expanded ? 'disclosure-expanded' : 'disclosure-collapsed'} size={14} className="shrink-0 text-text-secondary" />
          <span>{label}</span>
        </>
      )}
    >
      {children}
    </Collapsible>
  );
}

/** A bounded, keyboard-scrollable viewer for exact text main returned. */
export function DiagnosticsViewer({ testId, label, text }: { readonly testId: string; readonly label: string; readonly text: string }): ReactElement {
  return (
    <pre
      data-testid={testId}
      tabIndex={0}
      aria-label={label}
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-surface p-2 text-2xs leading-relaxed text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {text}
    </pre>
  );
}
