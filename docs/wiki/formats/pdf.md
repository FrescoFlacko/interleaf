[Wiki home](../README.md) › [Document formats](README.md) › PDF

# PDF

**Extensions:** `.pdf` · **Layout:** fixed · **Reader:** PDF.js

---

## What works well

- **The page looks exactly as published.** Fixed layout means fonts, figures and
  column layouts are preserved.
- **Real page numbers.** Type a number into the page field and you land on that
  page, permanently and repeatably.
- **Text selection and search** on any PDF that has a text layer.
- **Precise highlights.** Highlights are anchored by page and by the exact
  rectangles your selection covered, plus the quoted text — so they stay put.
- **Table of contents** from the PDF's own embedded bookmarks, via the
  **Outline** button or `T`.
- **The only format that supports a chat page range.** In AI Chat you can attach
  *pages 12–18* directly; see [AI Chat](../ai-chat.md#attaching-context).

Large PDFs stay responsive: Interleaf renders only the pages near your viewport
and releases the rest.

---

## Limitations

### Scanned, image-only PDFs have no text

If a PDF is a photograph or scan of pages with no text layer, there is nothing
to select, search, highlight as text, or send to the AI as context. Interleaf
does **not** perform OCR, so this cannot be worked around inside the app. Run the
file through an OCR tool that adds a text layer, then import the result.

A quick test: try to select a sentence. If nothing selects, there is no text
layer.

### Encrypted and password-protected PDFs

A password-protected PDF is reported as a reader error. Interleaf does not prompt
for a password and does not store one. Remove the password with the tool that
created the file, then import it.

### No editing, forms or annotations-in-file

- Interleaf never writes to your PDF. Your highlights and notes live in
  Interleaf's database.
- **PDF form fields are not interactive**, and XFA forms are not rendered.
- **Annotations stored inside the PDF are not rendered**, and neither are
  embedded document actions — a PDF cannot make Interleaf do anything when you
  open it.
- **Embedded scripting is never executed.**
- **Remote resources referenced by the PDF are never fetched.**

### No reflow

Line spacing and reading margins do not apply — they are properties of the
printed page. Use **Zoom preset**, *Fit Width* or *Fit Page* instead.

---

## Tips

- *Fit Width* is usually the most readable setting for a single-column paper;
  *Fit Page* is better for slides.
- For a very wide or landscape PDF, Focus Reading Mode (`F11`) buys you the
  horizontal space the panels were using.
- If search finds nothing in a PDF you know contains the word, check first
  whether the document has a text layer at all, then try **Retry index** in the
  Search panel.

---

Next: [EPUB](epub.md) · [Back to formats](README.md) ·
[Reading a document](../reading.md)
