[Wiki home](README.md) › Highlights and notes

# Highlights and notes

Interleaf saves three kinds of annotation: **highlights**, **notes** and
**bookmarks**. All of them live in Interleaf's own database — your document file
is never modified.

**On this page**

- [Highlighting a passage](#highlighting-a-passage)
- [Notes](#notes)
- [Bookmarks](#bookmarks)
- [The Annotations browser](#the-annotations-browser)
- [Editing and deleting](#editing-and-deleting)
- [When a highlight loses its place](#when-a-highlight-loses-its-place)
- [Size limits on a single selection](#size-limits-on-a-single-selection)

---

## Highlighting a passage

1. Select text in the reader. The **Selection actions** toolbar appears next to
   your selection.
2. Under the word **Highlight**, click one of the five colour swatches.
3. The highlight is saved immediately and painted on the page. The toolbar
   closes and you keep reading: the companion panel stays as it was — closed,
   or open on whichever tab you had — and on a narrow window the companion
   drawer does not open. To see your highlights, open the **Annotations** tab
   yourself (see [The Annotations browser](#the-annotations-browser)).

The five colours are **Yellow**, **Blue**, **Green**, **Pink** and **Purple**.
Yellow is the default. Colour is never the only cue: hovering or
keyboard-focusing a swatch shows its name in plain text beside the row, and each
button's accessible name is, for example, *Yellow highlight*.

The same toolbar also offers:

| Button | What it does |
| --- | --- |
| **Add note** | Attaches a note to the selected passage (see below). |
| **Copy** | Copies the selected text to the clipboard. |
| **Ask AI** | Sends the selection to the AI Chat panel as context. See [AI Chat](ai-chat.md). |
| **Submit to agent** | Attaches the selection to an agent task. See [AI Agent](ai-agent.md). |
| × | Closes the toolbar. `Esc` does the same. |

---

## Notes

There are two kinds, and they behave differently. Both open the same small
note card, in your reading font.

Notes save themselves as you type: a moment after you pause, the card's status
changes from *Unsaved changes* to *Saved*. There is no Save or Cancel button.

- **Done**, or `⌘ Enter` / `Ctrl + Enter`, saves the latest text and closes
  the card.
- `Esc`, the **×** in the corner, or clicking elsewhere also save the latest
  text before they close it.
- Plain `Enter` starts a new line.
- A card you close without typing anything creates no note.
- If a save fails, the card stays open with your text and says why. Choose
  **Retry**, or **Discard** to give up the unsaved text. When the save cannot
  succeed by trying again, only **Discard** is offered.
- If the card goes away for another reason, such as when you open another
  document, the selection changes, or you edit a different row in the
  Annotations panel, your latest text is still saved to the note it was opened
  on. If that save fails, the note is kept. It reappears under **Note** the next
  time that document is open, with the text, the place it was anchored, the
  reason, and **Discard**, plus **Retry** when the save can be tried again.
  Only **Discard** gives the text up. It does not move your cursor. If the note already
  exists, editing it again from the Annotations panel continues the same
  unsaved text.
- Quitting Interleaf saves any note you are still typing first. Kept notes
  exist only while Interleaf is running, so if a save keeps failing at quit,
  or the app stops unexpectedly, the unsaved text is lost.

### A note on selected text

1. Select the passage.
2. Click **Add note** in the selection toolbar.
3. Type in the note card. The passage you selected is quoted above your text.
4. Click **Done** when you have finished.

The note is anchored to that passage, so it travels with the text. Unlike a
highlight, a note finished with **Done** opens the Annotations panel and
scrolls the new note into view (except in Focus Mode, which stays
distraction-free). Saving as you type, and closing the card any other way,
leave the panels as they were.

### A note at your current location

Use this when there is nothing in particular to select — a thought about the
page as a whole.

1. Click **Note** in the reader toolbar.
2. Type in the note card. Its top line shows where you are: the page and how
   far through the document.
3. Click **Done**.

In the Annotations browser, the two are labelled *Text note* and *Location note*.

---

## Bookmarks

Press `⌘ B` / `Ctrl + B`, or click **Bookmark** in the reader toolbar, to save
your place. The bookmark is labelled with the page it was made on, the
Annotations panel opens, and the new bookmark is scrolled into view so you can
rename it straight away.

---

## The Annotations browser

Open the companion panel's **Annotations** tab, or press `⌘ Shift + N` /
`Ctrl + Shift + N`.

The panel is headed **Annotations**, with a count of how many exist in the
current document.

- **Search box** (*Quote, note, label…*) — searches the highlighted text, your
  note text and bookmark labels.
- **Filter chips** — **All**, **Highlights**, **Notes**, **Bookmarks**, each
  showing its count.
- **Sort** — **Recent**, **Newest**, **Oldest**.
- Long lists are paginated.

![A PDF page with yellow, pink, green and blue highlights, and the Annotations tab listing a note and three highlights with their page numbers](../../website/assets/screens/reader-annotations-1600.webp)
*Highlights on the page and in the Annotations browser. The highlights and the note are demo annotations.*

Each entry offers:

| Action | Effect |
| --- | --- |
| **Jump** | Opens the document at that annotation. |
| **Edit** | Edits the note text or bookmark label. On a highlight with no note yet, the button reads **Add note**. |
| Colour swatches | On a highlight, click a swatch to recolour it in place. |
| **⋯ ▸ Delete** | Deletes the annotation, after a confirmation. |

Delete lives in the overflow menu rather than on the row, so a mis-aimed click
on a crowded row cannot destroy an annotation.

---

## Editing and deleting

Editing is inline. Choose **Edit** and change the text. A note's text, or a
highlight's note, opens in the same note card and saves as you type. Choose
**Done** when you have finished. Emptying a highlight's note removes the
note but keeps the highlight. A note needs some text, so to remove a note,
delete it instead. A bookmark's label still has **Save** and **Cancel**.

Deleting asks *Delete this annotation? This cannot be undone.* There is no undo
afterwards, so the confirmation is the only safety net.

---

## When a highlight loses its place

Reflowable documents can lay out differently after a font, width or version
change, and a highlight's original anchor may no longer match. Interleaf stores
several anchors per annotation — the format's own location plus the quoted text
and its surrounding context — and recovers the position automatically where it
can.

When it cannot, the entry offers **Re-attach** instead of **Jump**. Choosing it
opens the recorded location and shows:

> Opened the recorded location. If the moved text is on that page, its place is
> restored automatically.

So the workflow is: click **Re-attach**, look at the page, and if the passage is
there the anchor repairs itself.

---

## Size limits on a single selection

Highlights and notes are anchored to a specific passage, which means very large
selections cannot be stored as one annotation. If you select too much, the
toolbar explains the limit and points you at the right tool instead:

- *Highlights and notes are limited to 50 pages. Use Ask AI for large ranges.*
- *Highlights and notes are limited to 100 blocks. Use Ask AI for large ranges.*
- *Highlights and notes are limited to 100 paragraphs. Use Ask AI for large
  ranges.*
- *Highlights and notes are limited to 256,000 characters. Use Ask AI for large
  passages.*
- *Highlights and notes could not be mapped to document segments
  deterministically. Use Ask AI for this selection.*

In all of those cases **Ask AI** still works: chat context is not limited the
same way, and can take a page range or the whole document. See
[AI Chat](ai-chat.md#attaching-context).

---

Next: [AI Chat](ai-chat.md) · [Reading a document](reading.md) ·
[App navigation](navigation.md)
