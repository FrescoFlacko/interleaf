import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { AppIcon } from './AppIcon';
import { SLIDE_TRANSITION_MS, type SlidePhase } from './slide-presence';
import { useUiStore } from '../stores/use-ui-store';

type Props = {
  readonly side: 'left' | 'right';
  readonly label: string;
  readonly testId: string;
  readonly inert: boolean;
  readonly onClose: () => void;
  readonly onSwitch: () => void;
  readonly switchLabel: string;
  readonly switchTestId: string;
  /** Visual state owned by App's presence manager. */
  readonly slidePhase: SlidePhase;
  readonly children: ReactNode;
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(candidates).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[hidden]') !== null) return false;
    return true;
  });
}

export function CompactDrawer({
  side,
  label,
  testId,
  inert,
  onClose,
  onSwitch,
  switchLabel,
  switchTestId,
  slidePhase,
  children,
}: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    // Capture the pre-dialog return target, then move initial focus INTO the
    // drawer on the very commit that mounts it — pre-paint, so an observable
    // body-focus frame cannot exist between an outgoing drawer turning inert
    // and this drawer owning focus (panel switch included).
    const active = document.activeElement as HTMLElement | null;
    returnTargetRef.current = active?.closest('[role="dialog"]') === null ? active : null;

    if (!inert) {
      const drawer = drawerRef.current;
      if (drawer !== null) {
        const focusable = getFocusableElements(drawer);
        const first = focusable[0];
        if (first !== undefined) first.focus();
        else drawer.focus();
      }
    }

    return () => {
      const returnTarget = returnTargetRef.current;
      const toggleId = side === 'left' ? 'toggle-left-panel' : 'toggle-right-panel';

      const restore = (): void => {
        // Never steal focus: another compact drawer still open (switch) or any
        // dialog owning focus means the replacement surface is in charge.
        if (useUiStore.getState().compactActivePanel !== null) return;
        const activeNow = document.activeElement as HTMLElement | null;
        if (activeNow !== null && activeNow.closest('[role="dialog"]') !== null) return;
        const toggleBtn = document.querySelector<HTMLElement>(`[data-testid="${toggleId}"]`);
        if (returnTarget?.isConnected === true && returnTarget.closest('[role="dialog"]') === null && toggleBtn === null) {
          returnTarget.focus();
        } else {
          toggleBtn?.focus();
        }
      };

      window.requestAnimationFrame(restore);
    };
  }, [inert, side]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = getFocusableElements(drawer);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey) {
        if (
          document.activeElement === first ||
          document.activeElement === drawer ||
          (document.activeElement !== null && first.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (
          document.activeElement === last ||
          (document.activeElement !== null && last.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  };

  const isLeft = side === 'left';

  // Three honest phases: off-screen (no transition yet), sliding in/out via
  // transform, resting open. Reduced motion collapses durations globally.
  const offScreen = slidePhase !== 'open';
  const transform = offScreen
    ? `translateX(${isLeft ? '-' : ''}100%)`
    : 'translateX(0%)';
  // Longhand slide styles stay React-authored; phases flip them declaratively
  // and reduced motion collapses durations globally in the stylesheet.
  const slideStyles = {
    transform,
    transitionProperty: slidePhase === 'entering' ? 'none' : 'transform',
    transitionDuration: slidePhase === 'entering' ? '0ms' : `${String(SLIDE_TRANSITION_MS)}ms`,
    transitionTimingFunction: 'var(--ease-drawer)',
  } as const;

  return (
    <div
      ref={drawerRef}
      id={testId}
      data-testid={testId}
      data-slide-phase={slidePhase}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      inert={inert}
      aria-hidden={inert ? true : undefined}
      onKeyDown={handleKeyDown}
      className={`fixed inset-y-0 z-50 flex w-[min(340px,85vw)] max-w-full flex-col bg-bg-primary shadow-2xl ${
        isLeft ? 'left-0 border-r border-border-subtle' : 'right-0 border-l border-border-subtle'
      }`}
      style={slideStyles}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-subtle px-3 bg-bg-surface">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid={switchTestId}
            onClick={onSwitch}
            aria-label={switchLabel}
            title={switchLabel}
            className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-primary hover:text-text-primary"
          >
            <span className="flex items-center gap-1">
              {isLeft ? (
                <>
                  Companion
                  <AppIcon name="forward" size={12} />
                </>
              ) : (
                <>
                  <AppIcon name="back" size={12} />
                  Library
                </>
              )}
            </span>
          </button>
          <button
            type="button"
            data-testid="close-compact-drawer"
            onClick={onClose}
            aria-label="Close drawer"
            title="Close drawer (Escape)"
            className="rounded p-1 text-text-secondary hover:bg-bg-primary hover:text-text-primary"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
