/**
 * Keyboard shortcuts that are functional in the current phase. Only list
 * shortcuts that actually work — no aspirational bindings (AGENTS.md §116,
 * no fake affordances).
 */
export type ShortcutInfo = { readonly keys: string;
readonly action: string; }

export const ACTIVE_SHORTCUTS: readonly ShortcutInfo[] = [
  { keys: 'F11', action: 'Toggle Focus Reading Mode' },
  { keys: 'Esc', action: 'Exit Focus Mode / close overlays' },
  { keys: '⌘/Ctrl + O', action: 'Open a document' },
  { keys: '⌘/Ctrl + Shift + O', action: 'Import documents to the library' },
  { keys: '⌘/Ctrl + F', action: 'Open document search' },
  { keys: '⌘/Ctrl + + / −', action: 'Zoom in or out' },
  { keys: '⌘/Ctrl + 0', action: 'Reset reader zoom' },
  { keys: '⌘/Ctrl + B', action: 'Bookmark current reading location' },
  { keys: '⌘/Ctrl + Shift + A', action: 'Toggle right companion panel' },
  { keys: '⌘/Ctrl + Shift + N', action: 'Show annotations' },
  { keys: '?', action: 'Show keyboard shortcuts' },
];
