import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionDetail } from '@shared/types/agent';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import { useAgentStore } from '../../stores/use-agent-store';
import { discardOriginHolds, discardOriginOf, discardRunShown, type AgentDiscardOrigin } from '../../stores/agent-discard-origin';
import { Button } from '../../components/ui/button';
import { truncateForDisplay } from './agent-format';

/** The run the reader asked to discard, frozen when the confirmation opened. */
type DiscardTarget = {
  /** The run, book, attempt and exact review confirmed; the store refuses the discard unless all still hold. */
  readonly origin: AgentDiscardOrigin;
  /** Direct runs wrote straight into the working directory; there is no sandbox to remove. */
  readonly direct: boolean;
  readonly prompt: string;
  readonly workspaceLabel: string;
  readonly modeLabel: string;
  readonly directoryName: string;
};

type DiscardSandboxActionProps = {
  readonly session: AgentSessionDetail;
  readonly environment: AgentSessionEnvironment;
  readonly disabled: boolean;
};

/** Whether the store still shows the exact discard the confirmation was opened on. */
function originHolds(origin: AgentDiscardOrigin): boolean {
  return discardOriginHolds(origin, useAgentStore.getState());
}

/**
 * Discard Sandbox and the confirmation it opens. The confirmation is frozen to
 * the run, book, attempt and exact review it was opened on: any of them
 * changing — this run resuming included — withdraws it rather than letting it
 * act on what replaced it, and the store refuses a stale one in any case.
 */
export function DiscardSandboxAction({ session, environment, disabled }: DiscardSandboxActionProps): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<DiscardTarget | null>(null);
  const stale = target !== null
    && (target.origin.sessionId !== session.id || !originHolds(target.origin));

  useEffect(() => { if (stale) setTarget(null); }, [stale]);
  // A resume or a switch can land without re-rendering this card; the store's own change is what withdraws it.
  useEffect(() => {
    if (target === null) return undefined;
    return useAgentStore.subscribe(() => { if (!originHolds(target.origin)) setTarget(null); });
  }, [target]);

  const open = (): void => {
    const origin = discardOriginOf(useAgentStore.getState());
    if (origin?.sessionId !== session.id) return;
    setTarget({
      origin,
      direct: environment.mode === 'active-env' || environment.mode === 'native-restricted',
      prompt: session.userPrompt,
      workspaceLabel: environment.workspaceLabel,
      modeLabel: AGENT_EXECUTION_MODE_INFO[session.executionMode].label,
      directoryName: session.targetDirectory.displayName,
    });
  };

  return (
    <>
      <Button ref={triggerRef} size="chip" variant="danger" disabled={disabled} aria-haspopup="dialog" onClick={open}>
        Discard Sandbox
      </Button>
      {target !== null && !stale && (
        <AgentDiscardConfirm target={target} triggerRef={triggerRef} onClose={() => { setTarget(null); }} />
      )}
    </>
  );
}

type AgentDiscardConfirmProps = {
  readonly target: DiscardTarget;
  /** Discard Sandbox: it opened this confirmation, so focus goes back to it while it remains. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Takes everything else on the page out of reach while the confirmation is
 * open — the wide shell, the drawer and its controls alike — and returns a
 * release that hands it back as it was. Anything already inert stays inert;
 * focus that still lands outside is returned to Cancel.
 */
function isolate(scrim: HTMLElement, cancel: RefObject<HTMLButtonElement | null>): () => void {
  cancel.current?.focus();
  const covered = [...document.body.children].filter((element) => element !== scrim && !element.hasAttribute('inert'));
  for (const element of covered) element.setAttribute('inert', '');
  const keepFocus = (event: FocusEvent): void => {
    if (event.target instanceof Node && !scrim.contains(event.target)) cancel.current?.focus();
  };
  document.addEventListener('focusin', keepFocus);
  return () => {
    document.removeEventListener('focusin', keepFocus);
    for (const element of covered) element.removeAttribute('inert');
  };
}

/**
 * Where focus goes as the confirmation closes, if it still holds focus. It
 * returns to Discard Sandbox; once main has discarded the run that button
 * leaves with its review, so focus moves to the same run's New task button.
 * Focus another surface has taken, or a run that has moved on, is left alone:
 * a button React kept for the next run is not this run's.
 */
function returnFocus(origin: AgentDiscardOrigin, trigger: HTMLElement | null, scope: HTMLElement | null): void {
  const shown = (): boolean => discardRunShown(origin, useAgentStore.getState());
  if (!shown()) return;
  if (trigger?.isConnected === true) trigger.focus();
  // The commit closing this may also be removing the trigger; settle on what remains after it.
  queueMicrotask(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost || !shown() || scope?.isConnected !== true) return;
    scope.querySelector<HTMLElement>('[data-testid="agent-back-button"]')?.focus();
  });
}

/**
 * Discarding cannot be undone, so it is confirmed first. Cancel holds the
 * initial focus; Escape, Cancel and a click outside close only this
 * confirmation and never reach main. It renders above the whole window and
 * keeps Tab and Escape to itself, so neither the drawer's own trap nor its
 * Escape shortcut acts while it is open.
 */
function AgentDiscardConfirm({ target, triggerRef, onClose }: AgentDiscardConfirmProps): ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const storeError = useAgentStore((state) => state.error);
  const { origin } = target;

  useLayoutEffect(() => {
    const scrim = scrimRef.current;
    const dialog = dialogRef.current;
    if (scrim === null || dialog === null) return undefined;
    const trigger = triggerRef.current;
    const scope = trigger?.closest<HTMLElement>('[aria-labelledby="agent-active-session-heading"]') ?? null;
    const release = isolate(scrim, cancelRef);
    return () => {
      const active = document.activeElement;
      const owned = active === null || active === document.body || dialog.contains(active);
      release();
      if (owned) returnFocus(origin, trigger, scope);
    };
  }, [origin, triggerRef]);

  const cancel = (): void => { if (!busyRef.current) onClose(); };

  const confirm = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const outcome = await useAgentStore.getState().discardSandbox(origin);
    if (outcome !== 'failed') { onClose(); return; }
    busyRef.current = false;
    setBusy(false);
    setFailed(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    event.stopPropagation();
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey ? active === first || !focusable.includes(active as HTMLElement) : active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return createPortal(
    <div
      ref={scrimRef}
      data-testid="agent-discard-scrim"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        data-testid="agent-discard-confirm"
        onKeyDown={handleKeyDown}
        className="max-h-full w-full max-w-sm overflow-auto rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-lg"
      >
        <h2 id={titleId} className="text-sm font-semibold text-text-primary">
          {target.direct ? 'Discard review data?' : 'Discard sandbox?'}
        </h2>
        <DiscardDescription id={descriptionId} target={target} />
        {failed && (
          <p role="alert" data-testid="agent-discard-error" className="mt-3 text-xs text-danger">
            {truncateForDisplay(storeError ?? 'Could not discard sandbox.')}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} size="sm" aria-disabled={busy} onClick={cancel}>Cancel</Button>
          <Button
            size="sm"
            variant="danger"
            aria-disabled={busy}
            data-testid="agent-discard-confirm-button"
            onClick={() => { void confirm(); }}
          >
            {busy ? 'Discarding…' : target.direct ? 'Discard review data' : 'Discard sandbox'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Names the run, its workspace and mode, and says what discarding does — and does not do — to it. */
function DiscardDescription({ id, target }: { readonly id: string; readonly target: DiscardTarget }): ReactElement {
  const directory = truncateForDisplay(target.directoryName, 120);
  return (
    <div id={id} className="mt-2 flex flex-col gap-1.5 text-xs leading-relaxed text-text-secondary">
      <dl className="agent-mono grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-2xs" data-testid="agent-discard-run">
        <dt>Run</dt>
        <dd className="truncate" title={truncateForDisplay(target.prompt, 240)}>{truncateForDisplay(target.prompt, 120)}</dd>
        <dt>Workspace</dt>
        <dd className="truncate">{truncateForDisplay(target.workspaceLabel, 120)}</dd>
        <dt>Mode</dt>
        <dd className="truncate">{target.modeLabel}</dd>
      </dl>
      {target.direct ? (
        <>
          <p>This removes Interleaf’s snapshot and review data for this run.</p>
          <p className="font-medium text-text-primary">
            It does not undo changes the agent already made in {directory}; they remain there.
          </p>
        </>
      ) : (
        <p>This permanently removes the agent’s un-applied changes. They cannot be recovered. The working directory, {directory}, is not changed.</p>
      )}
      <p>This run cannot be resumed afterwards.</p>
    </div>
  );
}
