import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { ACTIVE_SHORTCUTS } from "@shared/constants/shortcuts";
import { useUiStore } from "../stores/use-ui-store";
import { phaseAttributes, useModalPresence } from "./ui/popover-presence";

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Focuses `target` while `visible`, and hands focus back to where it was after. */
function useFocusWhileVisible(visible: boolean, target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!visible) return undefined;
    const returnTo = focusedElement();
    target.current?.focus();
    return () => {
      returnTo?.focus();
    };
  }, [visible, target]);
}

/** The presence key: the dialog has one content, so it is either shown or not. */
function presenceKey(open: boolean): true | null {
  return open ? true : null;
}

/** Only an open dialog takes focus; a fading one keeps out of the way. */
function takesFocus(open: boolean, shown: true | null): boolean {
  return open && shown !== null;
}

/** Stays mounted; fades out over 100ms, inert, after `open` turns false. */
export function ShortcutsDialog({ open }: { readonly open: boolean }) {
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { shown, phase } = useModalPresence(presenceKey(open));
  useFocusWhileVisible(takesFocus(open, shown), closeRef);

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      setShortcutsOpen(false);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Tab") {
      event.preventDefault();
      closeRef.current?.focus();
    }
  }

  if (shown === null) return null;

  return (
    <div
      {...phaseAttributes(phase)}
      className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        data-testid="shortcuts-dialog"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        data-phase={phase}
        className="ui-dialog w-[26rem] max-w-[90vw] rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="shortcuts-dialog-title" className="text-base font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={() => { setShortcutsOpen(false); }}
            aria-label="Close keyboard shortcuts"
            className="rounded-md border border-border-subtle px-2 py-1 text-sm hover:bg-bg-surface"
          >
            Close
          </button>
        </div>
        <ul className="mt-4 flex flex-col gap-3">
          {ACTIVE_SHORTCUTS.map((shortcut) => (
            <li key={shortcut.keys} className="flex items-center justify-between gap-4">
              <span className="text-sm">{shortcut.action}</span>
              <kbd className="shrink-0 rounded-md border border-border-subtle bg-bg-surface px-2 py-0.5 font-mono text-xs">
                {shortcut.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-text-secondary">Press Esc to close.</p>
      </div>
    </div>
  );
}
