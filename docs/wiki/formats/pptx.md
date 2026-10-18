[Wiki home](../README.md) › [Document formats](README.md) › PPTX

# PPTX (PowerPoint)

**Extension:** `.pptx` · **Layout:** reflowable, one page per slide · **Reader:**
Interleaf's Word reader, adapted for decks

Interleaf reads PowerPoint decks as **reading text**: each slide becomes one
widescreen page holding the slide's title, bullets, tables and still pictures.
It is built for reading, annotating, searching and asking about a deck, not for
presenting it.

---

## What works well

- **One page per slide, in the deck's own order.** The page counter counts
  slides, and the **Outline** (`T`) lists one entry per slide, using the slide
  title or `Slide N` when there is none.
- **Slide text keeps its structure**: the title as the slide heading, bullet and
  numbered lists with their levels, bold and italic emphasis, and tables.
- **Still pictures render** when they are PNG, JPEG, GIF or WebP images stored
  inside the deck.
- **Full-text search** across every slide, with results labelled by slide.
- **Highlights and notes** are anchored to a paragraph and a character range on
  the slide, like DOCX.
- **AI Chat** can use a selection, your current slide or the whole deck as
  context, and its citations jump back to the slide.

---

## Limitations

### A reading view, not a slide-faithful rendering

Interleaf does not reproduce how the deck looks in PowerPoint. It does not read
masters, layouts or themes, positioned shapes, fills and backgrounds, charts or
SmartArt drawings. Expect the deck's words and pictures in Interleaf's
typography, laid out top to bottom on each slide.

### Speaker notes are not read

Only what is on the slides is shown, searched and sent to AI. Notes stay in the
file.

### Active content is refused, not run

A deck is a common carrier for more than slides, and none of it is honoured:

- **Macro-enabled decks and VBA projects**, **ActiveX controls** and **embedded
  OLE objects** fail the whole open. Interleaf checks the package itself, so
  renaming a `.pptm` to `.pptx` does not get around this.
- **Audio, video, animations and transitions** are never played or read.
- **External links and remote pictures** are never fetched while you read.

### Size limits

Decks are parsed under strict bounds (for example, at most 2,000 slides and
8 MiB per picture). A deck over a limit refuses to open with a message saying
so, rather than opening partially.

### No editing

Interleaf never writes to your `.pptx`. Highlights, notes and bookmarks live in
Interleaf's database.

---

## Tips

- The old binary `.ppt` format is not supported. Save it as `.pptx` in
  PowerPoint, Keynote or LibreOffice Impress first.
- A Word document renamed to `.pptx` (or a deck renamed to `.docx`) is refused:
  Interleaf checks what the file actually contains.
- To read a deck someone sent you without adding it to your library, use
  **Open file** rather than **Import**. See
  [Adding documents](../adding-documents.md#open-a-file-without-importing-it).

---

Next: [Markdown and saved web articles](markdown-and-web-articles.md) ·
[Back to formats](README.md)
