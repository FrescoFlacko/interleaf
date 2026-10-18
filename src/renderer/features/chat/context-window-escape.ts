/**
 * Whether the panel still holds the reader's focus. Escape returns focus to the
 * wheel only from inside the panel; once the reader has tabbed on to the
 * composer or the thread, closing the panel must leave their focus where they
 * put it rather than pulling it backwards.
 */
export function holdsFocus(panel: HTMLElement | null): boolean {
  return panel?.contains(document.activeElement) === true;
}

/**
 * What Escape closes: the innermost layer the reader is actually inside.
 *
 * From within the panel, an open question is the innermost thing, so it is
 * answered first and the reader is handed back to the control that asked it,
 * with the panel still up behind them. From anywhere else the panel — and with
 * it the question — simply goes away, and focus stays where the reader put it.
 */
export function resolveEscape(escape: {
  readonly inside: boolean;
  readonly confirming: boolean;
  readonly onCancelQuestion: () => void;
  readonly onDismiss: (restoreFocus: boolean) => void;
}): void {
  if (escape.confirming && escape.inside) {
    escape.onCancelQuestion();
    return;
  }
  escape.onDismiss(escape.inside);
}
