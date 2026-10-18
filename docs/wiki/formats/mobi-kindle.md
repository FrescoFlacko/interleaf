[Wiki home](../README.md) › [Document formats](README.md) › MOBI and Kindle

# MOBI, AZW and AZW3 (Kindle)

**Extensions:** `.mobi`, `.azw`, `.azw3` · **Layout:** reflowable ·
**Reader:** a hardened Foliate-derived parser

All three extensions open through the same reader. Interleaf handles the older
MOBI6 format, the newer KF8/AZW3 format, and combined files that contain both.

---

## What works well

- **Reflowable text** with your font, spacing, margin and palette settings.
- **A section-based table of contents**, reachable from **Outline** or `T`.
- **Position memory** within a section, restored when you reopen the book.
- **Highlights and notes** anchored by section and position plus the quoted text
  and its context.
- **Full-text search** across the book.
- **Cover, title and author** are read from the file at import.
- **Images render** when they are ordinary stills stored inside the book — PNG,
  JPEG, GIF, WebP or AVIF, verified by their actual bytes rather than by their
  filename.

---

## Limitations

### DRM-protected Kindle books cannot be opened

Books bought from the Kindle store are normally protected. Interleaf refuses
them:

> This document appears to be DRM-protected and cannot be opened by Interleaf.

Removing Kindle DRM is permanently out of scope. This includes AZW, AZW3 and KFX
protection. Personal documents you sent to your own Kindle, and books from
DRM-free sources, open normally.

### KFX is not supported

Only MOBI, AZW and AZW3 files are read. The newer KFX container is a different
format and is not in the supported extension list.

### The book's own styling is replaced

As with EPUB, the book's markup is sanitised and Interleaf's typography is
applied. Scripts, frames, embeds, form controls, remote resources, audio and
video never reach the page. Captions and inert text around removed media remain.

### Page numbers are derived

MOBI books have sections, not pages. The numbers you see come from how the book
lays out at your current settings. Attach a selection or the whole document to
AI Chat rather than a page range — page ranges are offered for PDF only.

### Old, unusual or damaged files

Interleaf parses these formats under strict bounds and a time limit, and fails
rather than hanging on a malformed file. If a book will not open and is not
DRM-protected, the file itself is most likely damaged or built in an unusual
way.

---

Next: [DOCX](docx.md) · [Back to formats](README.md) ·
[Adding documents](../adding-documents.md)
