[Wiki home](README.md) › Keyboard shortcuts

# Keyboard shortcuts

Every shortcut listed here is implemented and working. Interleaf deliberately
does not advertise shortcuts that do not exist.

**On this page**

- [Shown in the app](#shown-in-the-app)
- [Reader navigation](#reader-navigation)
- [In the chat composer](#in-the-chat-composer)
- [How Escape behaves](#how-escape-behaves)
- [Not shortcuts](#not-shortcuts)

---

## Shown in the app

Press `?` at any time to see this list inside Interleaf. It also appears under
**Settings ▸ General**.

| macOS | Windows / Linux | Action |
| --- | --- | --- |
| `F11` | `F11` | Toggle Focus Reading Mode |
| `Esc` | `Esc` | Exit Focus Mode / close overlays |
| `⌘ O` | `Ctrl + O` | Open a document without adding it to the library |
| `⌘ ⇧ O` | `Ctrl + Shift + O` | Import documents to the library |
| `⌘ F` | `Ctrl + F` | Open document search |
| `⌘ +` / `⌘ −` | `Ctrl + +` / `Ctrl + −` | Zoom in or out |
| `⌘ 0` | `Ctrl + 0` | Reset reader zoom |
| `⌘ B` | `Ctrl + B` | Bookmark current reading location |
| `⌘ Shift + A` | `Ctrl + Shift + A` | Toggle right companion panel |
| `⌘ Shift + N` | `Ctrl + Shift + N` | Show annotations |
| `?` | `?` | Show keyboard shortcuts |

In the app's own list these appear in the combined form `⌘/Ctrl + O` — the `⌘`
half is for macOS and the `Ctrl` half for Windows and Linux.

---

## Reader navigation

These work while reading and are not in the in-app list.

| Key | Action |
| --- | --- |
| `→` or `Page Down` | Next page |
| `←` or `Page Up` | Previous page |
| `T` | Toggle the Table of Contents |

Two sensible exceptions:

- None of these fire while you are typing in a text field, a text area or a
  menu.
- In a Markdown document, a wide table that scrolls sideways keeps `←` and `→`
  for itself while it has keyboard focus, so you can actually scroll it. Page
  turning resumes as soon as focus leaves the table.

---

## In the chat composer

| Key | Action |
| --- | --- |
| `Enter` | Send the message |
| `Shift + Enter` | Insert a newline instead of sending |
| `↑` | Recall your previous prompts |

---

## How Escape behaves

`Esc` always closes the *topmost* thing, in this order:

1. The keyboard shortcuts dialog
2. The Settings dialog
3. Any other dialog, menu, popover or the selection toolbar
4. A slide-over drawer (in a narrow window)
5. Focus Reading Mode

So pressing `Esc` to dismiss a highlight toolbar will never accidentally drop
you out of Focus Mode in the same keystroke.

---

## Not shortcuts

To avoid a wasted search:

- **`Ctrl + ,` does not open Settings.** The Settings button carries that text as
  a tooltip, but the key combination is not currently handled. Use the button in
  the header.
- **There are no single-key shortcuts for highlight colours.** Highlighting is
  done by clicking a colour swatch in the selection toolbar. Hovering or
  keyboard-focusing a swatch shows its name (*Yellow*, *Blue*, *Green*, *Pink*,
  *Purple*) beside it, so colour is never the only cue.

---

Related: [App navigation](navigation.md) · [Reading a document](reading.md) ·
[AI Chat](ai-chat.md)
