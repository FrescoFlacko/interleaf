import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import type { SlidePhase } from '../../components/slide-presence';
import { createPortal } from 'react-dom';
import type { ChatContextItem, ChatSession } from '@shared/types/ai';
import { useUiStore } from '../../stores/use-ui-store';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import { useContextBudget } from './use-context-budget';
import { ChatCleanContextAction } from './ChatCleanContextAction';
import { ChatContextWindowBody } from './ChatContextWindowBody';
import type { CleanContextControlState } from './clean-context-readiness';
import { TITLE_ID } from './ChatContextUsageDetails';
import { contextWindowReadout, showsContextWindow, type ContextWindowReadout } from './context-window-readout';
import { holdsFocus, resolveEscape } from './context-window-escape';

/** Whether this conversation can be compacted, and the request that compacts it. */
export type CleanContextWiring = {
  readonly control: CleanContextControlState;
  readonly onClean: () => Promise<boolean>;
};

/** The compaction wiring, passed straight through from the chat panel that already derives it. */
type CleanContextProp = { readonly cleanContext: CleanContextWiring };

type ChatContextBudgetMeterProps = CleanContextProp & {
  readonly activeSession: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  readonly isStreaming: boolean;
};

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const POPOVER_ID = 'chat-context-budget-popover';

/**
 * The proportion ring.
 *
 * Without a proportion to draw — no window size, or no accounting at all — no
 * value arc is rendered and the track goes dashed: an unfilled solid ring would
 * read as a measured zero, which is a different and false claim.
 */
function BudgetRing({ fraction }: { readonly fraction: number | null }) {
  return (
    <svg
      className="chat-design-budget-ring"
      data-budget-ring={fraction === null ? 'unknown' : 'known'}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="chat-design-budget-ring-track" cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="1.5" />
      {fraction !== null && (
        <circle
          className="chat-design-budget-ring-value"
          cx="7"
          cy="7"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

/** Whether a press landed on the panel itself or on the trigger that opened it. */
function isOwnElement(target: EventTarget | null, panel: HTMLElement | null, trigger: HTMLElement | null): boolean {
  if (!(target instanceof Node)) return false;
  return [panel, trigger].some((element) => element?.contains(target) === true);
}

/**
 * The anchored panel. It is portalled to the document body and placed from the
 * trigger's own rectangle, because the composer's configuration row is a
 * horizontal scroll container that would clip a panel rendered inside it.
 */
function BudgetPopover({
  phase,
  readout,
  triggerRef,
  onDismiss,
  cleanContext,
}: CleanContextProp & {
  readonly phase: SlidePhase;
  readonly readout: ContextWindowReadout;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onDismiss: (restoreFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cleanTriggerRef = useRef<HTMLButtonElement>(null);
  const [confirmingClean, setConfirmingClean] = useState(false);
  const anchorStyle = useAnchoredPosition(triggerRef, panelRef, 'bottom');

  useEffect(() => { panelRef.current?.focus(); }, []);

  const cancelQuestion = useCallback((): void => {
    setConfirmingClean(false);
    window.queueMicrotask(() => { cleanTriggerRef.current?.focus(); });
  }, []);

  const escape = useCallback((): void => {
    resolveEscape({
      inside: holdsFocus(panelRef.current),
      confirming: confirmingClean,
      onCancelQuestion: cancelQuestion,
      onDismiss,
    });
  }, [cancelQuestion, confirmingClean, onDismiss]);

  useEffect(() => {
    if (phase === 'exiting') return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      if (isOwnElement(event.target, panelRef.current, triggerRef.current)) return;
      onDismiss(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      escape();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [escape, onDismiss, phase, triggerRef]);

  return createPortal(
    <div
      ref={panelRef}
      id={POPOVER_ID}
      data-testid="chat-context-budget-popover"
      role="dialog"
      aria-labelledby={TITLE_ID}
      tabIndex={-1}
      {...phaseAttributes(phase)}
      style={anchorStyle}
      className="ui-popover chat-design-popover focus:outline-none"
    >
      <ChatContextWindowBody readout={readout} />
      <ChatCleanContextAction
        control={cleanContext.control}
        confirming={confirmingClean}
        onConfirmingChange={setConfirmingClean}
        triggerRef={cleanTriggerRef}
        onClean={cleanContext.onClean}
      />
      <button
        type="button"
        data-testid="chat-context-budget-close"
        onClick={() => { onDismiss(true); }}
        className="self-end rounded px-1.5 py-0.5 text-2xs text-accent hover:bg-bg-surface focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        Close
      </button>
    </div>,
    document.body
  );
}

/** The panel is only named as a control's target while it exists. */
function panelWiring(open: boolean): { readonly 'aria-expanded': boolean; readonly 'aria-controls'?: string } {
  return open ? { 'aria-expanded': true, 'aria-controls': POPOVER_ID } : { 'aria-expanded': false };
}

/** The wheel itself: a glance at the proportion, and the press that explains it. */
function BudgetTrigger({
  readout,
  open,
  triggerRef,
  onToggle,
}: {
  readonly readout: ContextWindowReadout;
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}) {
  const label = readout.label;
  return (
    <button
      ref={triggerRef}
      type="button"
      data-testid="chat-context-budget"
      data-budget-total={readout.totalState}
      data-budget-level={readout.level}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      {...panelWiring(open)}
      onClick={onToggle}
      className="chat-design-context-meter focus:outline-none focus:ring-2 focus:ring-focus-ring"
    >
      <BudgetRing fraction={readout.fraction} />
    </button>
  );
}

/**
 * The composer's context wheel and the panel it opens.
 */
function ContextBudgetControl({
  readout,
  cleanContext,
}: CleanContextProp & { readonly readout: ContextWindowReadout }) {
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rightTab = useUiStore((ui) => ui.rightTab);

  const dismiss = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) window.queueMicrotask(() => { triggerRef.current?.focus(); });
  }, []);

  useEffect(() => {
    if (rightTab !== 'chat') setOpen(false);
  }, [rightTab]);

  const toggle = useCallback((): void => { setOpen((wasOpen) => !wasOpen); }, []);

  return (
    <>
      <BudgetTrigger
        readout={readout}
        open={open}
        triggerRef={triggerRef}
        onToggle={toggle}
      />
      {presence.present && (
        <BudgetPopover
          phase={presence.phase}
          readout={readout}
          triggerRef={triggerRef}
          onDismiss={dismiss}
          cleanContext={cleanContext}
        />
      )}
    </>
  );
}

/**
 * Context-budget indicator for the AI Chat composer, and the panel it opens —
 * which is also where `Clean Context` is offered, beside the figures that say
 * whether the conversation needs compacting.
 *
 * Main's accounting is held in memory, so a conversation can be compactable with
 * no figures to show for it. The wheel then still opens a panel that says the
 * statistics are unavailable and offers compaction; only when there is neither
 * accounting nor a compaction to offer does the wheel disappear.
 */
export function ChatContextBudgetMeter({
  activeSession,
  contextItems,
  isStreaming,
  cleanContext,
}: ChatContextBudgetMeterProps) {
  const budget = useContextBudget({ session: activeSession, contextItems, isStreaming });
  if (!showsContextWindow(budget, cleanContext)) return null;
  return <ContextBudgetControl readout={contextWindowReadout(budget)} cleanContext={cleanContext} />;
}
