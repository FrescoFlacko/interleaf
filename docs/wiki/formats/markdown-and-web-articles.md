[Wiki home](../README.md) › [Document formats](README.md) › Markdown and web articles

# Markdown and saved web articles

**Extensions:** `.md`, `.markdown`, plus web pages you capture ·
**Layout:** reflowable

These two share one reader. A web article you save becomes a Markdown snapshot,
so everything on this page applies to both.

**On this page**

- [Markdown files](#markdown-files)
- [Saved web articles](#saved-web-articles)
- [Tables](#tables)
- [Images](#images)
- [What is never captured or rendered](#what-is-never-captured-or-rendered)
- [Limitations](#limitations)

---

## Markdown files

Import a `.md` or `.markdown` file like any other document. It renders as
reflowable text with Interleaf's typography, and gets the full set of features:
highlights, notes, bookmarks, full-text search, reading-position memory and AI
Chat context with citations.

Headings become the table of contents (**Outline**, or `T`).

Annotations are anchored to a block and a character range within it, so they hold
their place when the text re-wraps.

**Mermaid diagrams** in fenced ` ```mermaid ` blocks are drawn as a still
picture beside the block. The diagram source stays visible and is what search,
citations and highlights use; the picture is only an illustration, displayed as
an image, so nothing in it runs or loads anything from the network.

---

## Saved web articles

Capture a page with the caret next to **+ Import** ▸ **From web URL…**. Step by
step instructions are in
[Adding documents ▸ Save a web article](../adding-documents.md#save-a-web-article).

What you end up with is an **offline snapshot**:

- The article's prose, cleaned of navigation, adverts and site chrome.
- Its headings, lists and (where possible) tables.
- The still images Interleaf was able to verify and archive, with their captions
  and alt text.
- Provenance: the source URL, the site name, and the time you captured it, shown
  in the document's details.

The snapshot contains no remote addresses at all, which is exactly why it still
reads correctly with no network — and why it looks the same next year as it does
today, even if the original page changes or disappears.

Only **public `http://` or `https://` pages** can be captured. Anything behind a
login is not reachable.

---

## Tables

Markdown pipe tables render as real tables. A table that is wider than your
reading column does not stretch the column or get clipped: it sits in a
horizontally scrollable region, so it stays complete and reachable even at a
narrow window or 200% zoom.

While such a table is too wide to fit and has keyboard focus, `←` and `→` scroll
it sideways instead of turning the page. Page turning resumes when focus moves
away. When the table fits, it is not a tab stop at all.

For captured web articles, a table from the source page becomes a Markdown table
where it translates cleanly. A table that uses merged cells (`rowspan` or
`colspan`), or is simply too large, is rendered as ordered paragraphs instead —
you keep the content rather than getting a scrambled grid.

---

## Images

Images render **only from what Interleaf has archived locally**. Nothing is ever
fetched from the network while you read.

For captured articles, an image is archived only if it is a genuine still in one
of five formats — **PNG, JPEG, WebP, GIF or AVIF** — verified by examining the
actual bytes, not the file extension. Animated files are refused as animations
even when they contain a single frame. A snapshot can hold up to **40** archived
images.

If some could not be kept, the import success message tells you how many — for
example *3 images couldn't be saved; their captions were kept.* Every figure that
was not archived still leaves its caption and alt text in place, so the article
reads as a whole.

One useful detail: archived images are read as **their alt text** by search, by
the search index and by AI Chat context. So a picture's description is
searchable and can be quoted by the AI, while the stored image data itself never
becomes a stray search hit or wasted context.

---

## What is never captured or rendered

In both Markdown files and captured articles:

- **Scripts and any active content.**
- **Video, audio, interactive embeds and canvas renderings.** Where a page had
  one, you get its caption and alt text.
- **SVG and other vector graphics.** Refused rather than sanitised — a chart
  drawn as SVG leaves its caption behind.
- **Remote images, stylesheets and fonts.**

This is the same permanent rule that applies to every format in Interleaf.

---

## Limitations

- **A web capture is a snapshot, not a mirror.** It is the article text and the
  figures that could be verified — not the page's layout, its interactive
  elements, or its comments.
- **Pages that need a login, a paywall bypass or JavaScript to produce their
  text** will not capture usefully.
- **Page numbers are derived** from how the document lays out at your current
  settings, as with every reflowable format. AI Chat page ranges are offered for
  PDF only; attach a selection or the whole document instead.
- **A canvas-drawn hero image** cannot be archived; where the page supplies a
  normal preview image instead, that is used.

---

Back to [Document formats](README.md) ·
[Adding documents](../adding-documents.md) · [AI Chat](../ai-chat.md)
