[Wiki home](README.md) › App navigation

# App navigation

A tour of the Interleaf window: what each area is called, what the buttons do,
and how to get from any one place to any other.

**On this page**

- [The overall layout](#the-overall-layout)
- [Header toolbar](#header-toolbar)
- [Library sidebar](#library-sidebar)
- [Library view](#library-view)
- [Reader](#reader)
- [Companion panel](#companion-panel)
- [Settings](#settings)
- [Focus Reading Mode](#focus-reading-mode)
- [Narrow windows](#narrow-windows)

---

## The overall layout

```text
┌──────────────────────────────────────────────────────────────┐
│  Header toolbar                                              │
├───────────────┬──────────────────────────┬───────────────────┤
│               │                          │                   │
│  Library      │  Library view            │  Companion panel  │
│  sidebar      │      or                  │  Chat · Search    │
│               │  Reader                  │  Annotations ·    │
│               │                          │  Agent            │
└───────────────┴──────────────────────────┴───────────────────┘
```

The left sidebar and the right companion panel can each be hidden, and both are
resizable. The centre shows either your library or the document you are reading.

---

## Header toolbar

Along the top, from left to right:

| Control | What it does |
| --- | --- |
| **Toggle Library sidebar** | Shows or hides the left sidebar. |
| **Reading palette** | A row of palette buttons — Paper, Sepia, Moss, Ocean, Graphite, Midnight. See [Reading](reading.md#reading-palettes). |
| **Toggle companion panel** | Shows or hides the right panel. Shortcut: `⌘ Shift + A` / `Ctrl + Shift + A`. |
| **Open file** | Opens a document to read without adding it to your library. Shortcut: `⌘ O` / `Ctrl + O`. See [Open a file without importing it](adding-documents.md#open-a-file-without-importing-it). |
| **Settings** | Opens the Settings dialog. |
| **Show keyboard shortcuts** | Opens the shortcuts reference. Shortcut: `?`. |

> The Settings button's tooltip mentions `Ctrl+,`. That key combination is not
> currently wired up — use the button. Every shortcut that *does* work is listed
> on [Keyboard shortcuts](keyboard-shortcuts.md).

---

## Library sidebar

Two sections, plus a footer.

**Library** — four saved views:

1. **All Documents**
2. **Continue Reading**
3. **Recently Added**
4. **Recently Read**

**Folders** — your own virtual folders. Use the **New** button (*Create new
folder*) to add one. Folders are labels, not places on disk: moving a document
into a folder does not move the file. Drag a document from the library grid onto
a folder to file it there, or onto **All Documents** to take it out of a folder.

**Total Books** in the footer shows how many documents your library contains.

---

## Library view

The main area when no document is open.

- **+ Import** — opens the file picker. The small caret beside it opens *Choose
  an import source* with **From files…** and **From web URL…**.
- **Search title, author...** — filters the library as you type. This searches
  library metadata; to search *inside* documents use the companion panel's
  **Search** tab.
- **Filter** and **Sort** controls narrow and reorder the list.
- **Grid View** / **List View** switch the layout.
- Each document card shows its cover, title and author. A card can also carry
  small status chips: **Linked** for a file you linked in place rather than
  copied, and **Missing** or **Changed** when that linked file has moved or been
  edited on disk. See
  [Adding documents](adding-documents.md#managed-copy-versus-link-in-place).

Click a document to open it in the reader.

---

## Reader

The reader's own toolbar sits above the page:

| Control | What it does |
| --- | --- |
| **Outline** | Opens the **Table of Contents** sidebar. Shortcut: `T`. |
| Page number field | Type a page number and press `Enter` to jump there. |
| **Display settings** | Line spacing (*Tight* / *Normal* / *Relaxed lines*), Reading margins (*Narrow* / *Normal* / *Wide*), a zoom preset, and **Zoom in** / **Zoom out**. |
| **Bookmark** | Saves a bookmark at your current location. Shortcut: `⌘ B` / `Ctrl + B`. |
| **Note** | *Note at current location* — a note attached to where you are, without selecting text. |
| **Focus** | Enters Focus Reading Mode. Shortcut: `F11`. |

Selecting text pops up a small **Selection actions** toolbar: a **Highlight**
group with five colour swatches, then **Add note**, **Copy**, **Ask AI** and
**Submit to agent**.

Full detail: [Reading a document](reading.md) and
[Highlights and notes](highlights-and-notes.md).

---

## Companion panel

The right-hand panel has four tabs:

| Tab | Purpose | Page |
| --- | --- | --- |
| **Chat** | Ask questions about the open document. | [AI Chat](ai-chat.md) |
| **Search** | Full-text search in this document or across the library. | [Reading ▸ Searching](reading.md#searching-inside-documents) |
| **Annotations** | Browse, filter and search your highlights, notes and bookmarks. | [Highlights and notes](highlights-and-notes.md#the-annotations-browser) |
| **Agent** | Set up and run a coding agent task. | [AI Agent](ai-agent.md) |

Handy shortcuts: `⌘ Shift + A` / `Ctrl + Shift + A` toggles the panel,
`⌘ Shift + N` / `Ctrl + Shift + N` jumps straight to **Annotations**, and
`⌘ F` / `Ctrl + F` jumps straight to **Search** with the field focused.

---

## Settings

Open Settings from the header. The navigation rail on the left has ten entries:

| Entry | What lives there |
| --- | --- |
| **General** | *Guided setup* with **Run guided setup**, plus the keyboard shortcut list. |
| **Reader** | Reader background, Font size, Font family (including an *OpenDyslexic-compatible* option), Line spacing, Content width, Paragraph spacing, Page margins. |
| **Appearance** | The six reading palettes, and *Chat and Agent text size*. |
| **Library** | Default view and default sort order. |
| **AI Providers** | Connect and configure every AI provider, and edit the built-in agent profile that belongs to each one. See [AI providers](ai-providers.md). |
| **Custom Profiles** | Define your own agent command-line profiles. |
| **Agent Working Directories** | Save folders the agent is allowed to work in, and assign a default folder per profile. |
| **Agent Sandboxing** | *Default execution mode* for new agent runs. |
| **Privacy** | *Confirm before opening external links*. |
| **Advanced** | *Record diagnostic debug logging*. |

At the bottom of the dialog: **Export Debug Log** and **Done**.

Built-in agent profiles do not have their own rail entry — each one is edited
inside the **AI Providers** row for the provider that runs it, so there is
exactly one editor per profile.

---

## Focus Reading Mode

Press `F11` to strip the window down to the page you are reading. Press `Esc` or
`F11` again to come back. `Esc` is layered: it closes the topmost thing first —
a dialog, then a menu or popover, then a drawer, and only then Focus Mode.

---

## Narrow windows

When the window is too narrow for three columns, the sidebar and the companion
panel become drawers that slide over the content instead of sitting beside it.
The same toggle buttons open them, and `Esc` closes the open drawer.

---

Next: [Reading a document](reading.md) ·
[Keyboard shortcuts](keyboard-shortcuts.md) ·
[Adding documents](adding-documents.md)
