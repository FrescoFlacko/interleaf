import { useEffect, useRef, type RefObject } from 'react';
import type { CleanContextControlState } from './clean-context-readiness';

const CONFIRM_ID = 'chat-clean-context-confirm-region';

type ChatCleanContextActionProps = {
  /** Whether compaction is available at all, and what it would call. */
  readonly control: CleanContextControlState;
  /** Whether the inline confirmation is currently shown. */
  readonly confirming: boolean;
  readonly onConfirmingChange: (confirming: boolean) => void;
  /** The panel that owns the confirmation needs to return focus here. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClean: () => Promise<boolean>;
};

/**
 * Clean Context: compact the conversation so far into a model-authored summary.
 *
 * It lives inside the context-window panel, beside the figures that say why a
 * conversation would need compacting. It spends a real provider call and changes
 * what every later turn sees, so it asks first and says both things the reader
 * cannot otherwise know — which provider will be called, and that the attached
 * context chips go away.
 *
 * The question is asked inline rather than in a second dialog on top of the
 * panel's own: a nested dialog inside an anchored panel is what breaks at narrow
 * widths and 200% zoom, and a disclosure inside the panel keeps one top layer,
 * one Escape target and one scroll container.
 */
export function ChatCleanContextAction({
  control,
  confirming,
  onConfirmingChange,
  triggerRef,
  onClean,
}: ChatCleanContextActionProps) {
  const { isCleaning, target } = control;
  const canClean = control.canClean;
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirming) return undefined;
    let cancelled = false;
    window.queueMicrotask(() => {
      const button = confirmRef.current?.querySelector<HTMLElement>('button');
      // A panel already fading out is inert and never takes focus back.
      if (cancelled || button?.closest('[inert]')) return;
      button?.focus();
    });
    return () => { cancelled = true; };
  }, [confirming]);

  // A cleanup that becomes unavailable mid-question (a send starts, the session
  // is switched) must not leave an armed confirm button behind.
  useEffect(() => {
    if (!canClean || isCleaning) onConfirmingChange(false);
  }, [canClean, isCleaning, onConfirmingChange]);

  if (!control.present) return null;
  const disabled = !canClean || isCleaning;

  return (
    <div data-testid="chat-clean-context" className="chat-design-clean-context">
      <button
        ref={triggerRef}
        type="button"
        data-testid="chat-clean-context-trigger"
        aria-expanded={confirming}
        {...(confirming ? { 'aria-controls': CONFIRM_ID } : {})}
        aria-busy={isCleaning}
        disabled={disabled}
        onClick={() => { onConfirmingChange(!confirming); }}
        className="self-start whitespace-nowrap rounded px-1.5 py-0.5 text-2xs text-accent hover:bg-bg-surface focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40"
      >
        Clean Context
      </button>
      {isCleaning && (
        <p data-testid="chat-clean-context-status" role="status" className="text-2xs leading-snug text-text-secondary">
          Cleaning this conversation…
        </p>
      )}

      {confirming && !disabled && (
        <div
          ref={confirmRef}
          id={CONFIRM_ID}
          data-testid="chat-clean-context-confirm-region"
          role="group"
          aria-label="Clean Context"
          className="flex min-w-0 flex-col gap-2"
        >
          <p className="text-2xs leading-snug text-text-primary">
            This asks {target} to summarise the conversation so far, then uses that summary in place of
            the earlier turns. Your messages stay visible, and the attached context is removed.
          </p>
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              data-testid="chat-clean-context-cancel"
              onClick={() => {
                onConfirmingChange(false);
                window.queueMicrotask(() => { triggerRef.current?.focus(); });
              }}
              className="rounded border border-border-subtle px-2 py-1 text-2xs text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="chat-clean-context-confirm"
              disabled={disabled}
              onClick={() => {
                onConfirmingChange(false);
                void onClean();
              }}
              className="rounded bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40"
            >
              Clean Context
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
