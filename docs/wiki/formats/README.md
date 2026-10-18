[Wiki home](../README.md) › Document formats

# Document formats

Interleaf reads six formats. Each has its own reader (PPTX shares the Word
reader), so what you can do — reflow the text, search it, anchor a highlight to
it — differs a little by format. This page is the summary; each format has its own page with the detail.

**On this page**

- [At a glance](#at-a-glance)
- [Fixed layout versus reflowable](#fixed-layout-versus-reflowable)
- [What every format has in common](#what-every-format-has-in-common)
- [Images and media, across all formats](#images-and-media-across-all-formats)
- [Per-format guides](#per-format-guides)

---

## At a glance

| Format | Extensions | Layout | Page numbers | Table of contents | Notable limits |
| --- | --- | --- | --- | --- | --- |
| [PDF](pdf.md) | `.pdf` | Fixed | Real, from the file | From embedded bookmarks, if any | No text in scanned image-only files; encrypted files cannot be opened |
| [EPUB](epub.md) | `.epub` | Reflowable | Derived from your layout | From the book's navigation | DRM-protected books are refused |
| [MOBI / Kindle](mobi-kindle.md) | `.mobi`, `.azw`, `.azw3` | Reflowable | Derived from sections | Section-based | DRM-protected books are refused |
| [DOCX](docx.md) | `.docx` | Reflowable | **Derived hints, not Word's pages** | From headings | Not a pixel-identical Word rendering; macros and embedded objects are refused |
| [PPTX](pptx.md) | `.pptx` | One reflowable page per slide | Slide numbers | One entry per slide | A reading view, not the slide design; no speaker notes, animation or media; macros refused |
| [Markdown & web articles](markdown-and-web-articles.md) | `.md`, `.markdown`, captured pages | Reflowable | Derived from your layout | From headings | Only locally archived images render; no remote images |

---

## Fixed layout versus reflowable

**Fixed layout** (PDF) means the page is exactly as the publisher designed it.
Changing your font size or window width does not re-wrap the text; it zooms. Page
numbers are real and stable.

**Reflowable** (EPUB, MOBI, DOCX, PPTX, Markdown) means the text re-wraps to fit your
window, font and spacing settings. That is far more comfortable to read, but it
means "page 42" depends on how you have things set up.

Practical consequences:

- The **Line spacing** and **Reading margins** controls in the reader's
  **Display settings** apply to reflowable formats only. The popover says so.
- Chat's **page range** context is offered for PDF only, because that is the only
  format where a page number means the same thing to you and to the document.
  Other formats use selections, your current location, or the whole document.
- Highlights in reflowable formats are anchored by several means at once, so they
  survive a change of layout. See
  [Highlights and notes](../highlights-and-notes.md#when-a-highlight-loses-its-place).

---

## What every format has in common

Whatever you open, you get:

- Highlights in five colours, notes on text, notes at a location, and bookmarks.
- Full-text search, in the document and across the library.
- A remembered reading position.
- AI Chat context and citations that jump back to the right place.
- The same reading palettes, zoom and Focus Reading Mode.

---

## Images and media, across all formats

- **Ordinary still images render** under each format's own rules.
- **Interactive media never does.** Audio, video, executable embeds, frames,
  forms and document-supplied canvas programs are removed or refused, in every
  format, permanently. There is no setting to turn this on.
- Remote resources are never fetched while you read. A book that references an
  image on the web shows nothing for it rather than reaching out.
- Your original file is never modified by any of this.

---

## Per-format guides

- [PDF](pdf.md)
- [EPUB](epub.md)
- [MOBI, AZW and AZW3 (Kindle)](mobi-kindle.md)
- [DOCX (Word)](docx.md)
- [PPTX (PowerPoint)](pptx.md)
- [Markdown and saved web articles](markdown-and-web-articles.md)

---

Related: [Adding documents](../adding-documents.md) ·
[Reading a document](../reading.md) ·
[Help and troubleshooting](../help-and-troubleshooting.md)
