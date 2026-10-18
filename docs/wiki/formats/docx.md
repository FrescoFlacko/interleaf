[Wiki home](../README.md) › [Document formats](README.md) › DOCX

# DOCX (Word)

**Extensions:** `.docx` · **Layout:** reflowable · **Reader:** Interleaf's own
Office Open XML reader

Interleaf reads Word documents directly rather than converting them, and lays
them out responsively for comfortable reading.

---

## What works well

- **Document structure is preserved**: headings, paragraphs, bold and italic
  emphasis, alignment, ordered and unordered lists including nested ones, tables,
  and explicit page breaks.
- **Tables are readable**, and paragraphs inside table cells are individually
  addressable — you can highlight a sentence in a cell and it will stay anchored.
- **Headings drive the table of contents** (**Outline** or `T`).
- **Still images render** when they are static PNG, JPEG, GIF or WebP.
- **Full-text search** with accurate jump-to-source.
- **Highlights and notes** are anchored to a paragraph and a character range, so
  they survive a change of window width or font.

---

## Limitations

### Page numbers are hints, not Word's pages

This is the most important thing to know about DOCX in Interleaf. Word paginates
using the exact fonts and printer settings on *your* machine; Interleaf lays the
document out responsively for reading on screen. So:

- The page count shown is **derived**, and it can change if you resize the
  window or change your font settings.
- It will not necessarily agree with what Word shows for the same file.
- Your annotations are **not** affected by this. They are anchored to paragraphs
  and character ranges, which do not move when the derived page numbers do.

If you need a page number that means something to a colleague, cite the heading
or quote the sentence rather than the page.

### Not a pixel-identical Word rendering

Interleaf preserves semantics — structure, emphasis, lists, tables, images —
rather than reproducing Word's exact layout. Expect the same content in
Interleaf's typography, not a facsimile. Headers and footers, precise column
geometry and print-specific layout are not the reader's concern.

### No editing

Interleaf never writes to your `.docx`. Highlights, notes and bookmarks live in
Interleaf's database.

### Active content is refused, not run

A Word file can carry a lot more than text, and none of it is honoured:

- **Macros and VBA projects** — refused. A macro-enabled document's active parts
  never load, regardless of what the file is named.
- **ActiveX controls**, **embedded OLE and package objects**, attached toolbars
  and custom UI parts — refused.
- **Audio and video parts** — refused.
- **External relationships** — never fetched. A document cannot pull anything
  from the network while you read it.
- **Vector drawings and SVG** — not rendered. Only verified static rasters are.

This is checked by inspecting the parts themselves, not by trusting file
extensions.

### Comments and tracked changes

The reader presents the document body. Word review features are not part of what
it renders.

---

## Tips

- A `.doc` (the old binary Word format) is not supported. Open it in Word or
  LibreOffice and save as `.docx` first.
- Very large documents are parsed under strict size and time bounds. If a file
  refuses to open, it may exceed them or be malformed.

---

Next: [PPTX (PowerPoint)](pptx.md) ·
[Back to formats](README.md)
