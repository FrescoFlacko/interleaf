[Wiki home](README.md) › Adding documents

# Adding documents

**On this page**

- [What Interleaf can open](#what-interleaf-can-open)
- [Open a file without importing it](#open-a-file-without-importing-it)
- [Import from files](#import-from-files)
- [Drag and drop](#drag-and-drop)
- [Managed copy versus link in place](#managed-copy-versus-link-in-place)
- [Save a web article](#save-a-web-article)
- [Duplicates](#duplicates)
- [Organising your library](#organising-your-library)
- [Document details](#document-details)
- [Removing a document](#removing-a-document)
- [When an import fails](#when-an-import-fails)

---

## What Interleaf can open

| Format | Extensions |
| --- | --- |
| PDF | `.pdf` |
| EPUB | `.epub` |
| MOBI / Kindle | `.mobi`, `.azw`, `.azw3` |
| Word | `.docx` |
| PowerPoint | `.pptx` |
| Markdown | `.md`, `.markdown` |

Plus **web articles**, which Interleaf captures and stores as Markdown
snapshots.

Anything else is refused with a message naming the supported extensions:

> Unsupported file extension: '.xyz'. Supported extensions are .pdf, .epub,
> .mobi, .azw, .azw3, .docx, .pptx, .md, .markdown.

For what each format supports once it is open, see
[Document formats](formats/README.md).

---

## Open a file without importing it

Sometimes you only want to read a file, not keep it. **Open** reads a document
where it is, without adding it to your library:

- Choose **File ▸ Open…** or press `⌘ O` / `Ctrl + O`.
- Double-clicking a supported file in your file manager, or choosing Interleaf
  under *Open With*, does the same.

An opened file behaves like a library document while it is open: you can read,
search, highlight, take notes and use AI Chat. The difference is what happens
afterwards:

- **Nothing is kept.** Its highlights, notes, reading position and chat live in
  a temporary store that is discarded when you close the file. Interleaf reads
  from a private staged copy, which is removed on close and again at the next
  start.
- **One at a time.** Opening another file replaces the current one once the new
  file has loaded; if the new file is refused, the current one stays open.
- **No Agent Mode.** Agent tasks are refused with *Agent Mode works with
  documents in your library.*

To keep a document and its annotations, use **Import to Library** instead.

| | Open (`⌘ O` / `Ctrl + O`) | Import to Library (`⌘ ⇧ O` / `Ctrl + Shift + O`) |
| --- | --- | --- |
| Joins the library | No | Yes |
| Highlights, notes, chat | Discarded on close | Kept |
| Agent Mode | Not available | Available |

---

## Import from files

1. In the Library, click **+ Import**, choose **File ▸ Import to Library…**, or
   press `⌘ ⇧ O` / `Ctrl + Shift + O`.
   *(The caret next to the button opens **Choose an import source** with **From
   files…** and **From web URL…**.)*
2. The system dialog **Import Documents to Interleaf** opens. Its default filter,
   *Supported Documents (PDF, EPUB, MOBI, DOCX, PPTX, Markdown)*, shows everything
   Interleaf can read; you can narrow it to one format, for example *EPUB eBooks
   (\*.epub)* or *PowerPoint Presentations (\*.pptx)*.
3. Select one file or several.
4. Click **Import**.

Each document appears in the library as soon as it is ingested. Text extraction
and search indexing continue in the background.

---

## Drag and drop

On an empty library, the main area shows **Add books to your library** —
*Drag and drop files here, or click to browse. Supports PDF, EPUB, MOBI/AZW3,
DOCX, and Markdown.* PowerPoint `.pptx` files are accepted too, even though
that line does not list them. You can drop files onto it, use **Select Documents...**, or
choose the web-article action.

This is also where the **Storage mode** choice lives.

Once your library has books, you can still drop files anywhere on the library
view: they are imported into the folder you are viewing, or into the library
root from **All Documents** and the other sections. The view is outlined while
files are held over it. You can also drop files straight onto a folder or
subfolder in the sidebar to import them there, or onto **All Documents** to
import them without a folder. These drops always make a **Managed Copy**. A
drop is ignored while an earlier drop is still importing.

---

## Managed copy versus link in place

Two radio buttons, **Managed Copy (Default)** and **Link in Place**:

| | Managed Copy *(default)* | Link in Place |
| --- | --- | --- |
| Where the file lives | Copied into Interleaf's own storage | Stays exactly where it is |
| If you move or delete the original | No effect — Interleaf has its own copy | Interleaf can no longer open it |
| Disk usage | One extra copy per document | None |
| Best for | Most people; a library that looks after itself | Large files, or a collection you manage yourself with other tools |

Linked documents are watched for drift. In the library, a linked card shows a
**Linked** chip, and if something changes it gains:

- **Missing** — *File missing from original path*
- **Changed** — *File changed on disk*
- **Checking...** — the check is still running

Your annotations are stored in Interleaf's database either way, so they are not
lost when a linked file goes missing — you just cannot open the document until
the file is back.

---

## Save a web article

Interleaf can capture a web page as a clean, offline, reflowable Markdown
document that you can highlight, annotate, search and ask about just like a book.

1. Click the caret next to **+ Import** and choose **From web URL…**.
2. In **Import from web URL**, paste the address into **Article address**
   (for example `https://example.com/article`).
3. Click **Import article**. While it works, it shows *Fetching and cleaning the
   article…*.

What you get, in the modal's own words:

> Interleaf saves a clean, offline copy of the article text and the still images
> it can archive. Scripts, interactive embeds, and other active content are left
> behind.

Specifically:

- **Only public `http://` or `https://` pages.** The hint under the field says
  so. Pages behind a login are not captured.
- **The text is saved in full**, as Markdown, with its headings and structure.
- **Still images are archived where they can be verified** — PNG, JPEG, WebP,
  GIF and AVIF stills, up to **40 images** per article. Captions and alt text are
  kept for every figure.
- **Animated, vector and interactive content is refused, not sanitised.** SVG
  charts, canvas renderings, video and interactive embeds leave their caption and
  alt text behind rather than a broken image.
- **Tables from the page** become Markdown tables where they translate cleanly.
  A table using merged cells degrades to ordered paragraphs rather than risking a
  scrambled grid.
- **Nothing remote remains in the snapshot**, which is what makes it readable
  offline later.

If some pictures could not be kept, the success message says so as a count —
for example *3 images couldn't be saved; their captions were kept.* That is a
note on a successful import, not an error: the prose is complete.

Saved articles keep their provenance (the source URL, the site name, and when
you captured it), shown in the document's details.

More: [Markdown and saved web articles](formats/markdown-and-web-articles.md).

---

## Duplicates

Interleaf identifies documents by a SHA-256 hash of their content. Importing a
file you already have does not create a second entry; for a web article you
already captured you will see *"<title>" is already in your library.*

---

## Organising your library

**Folders** in the sidebar are virtual: they organise your library without
moving anything on disk.

- **New** (*Create new folder*) in the Folders header creates one; folders can be
  nested with **Create New Subfolder**.
- Drag a document card onto a folder to file it there. Dropping files from
  your computer onto a folder imports them into it (see [Drag and drop](#drag-and-drop)).
- Drag it onto **All Documents** to take it out.
- **Rename Folder** and **Delete Folder** are available on each folder.

**Finding things in the list:**

- **Search title, author...** filters by metadata as you type.
- The format filter offers *All Formats*, *PDF*, *EPUB*, *MOBI / AZW*, *DOCX*,
  *PowerPoint* and *Markdown*.
- Sorting offers *Recently Added*, *Recently Read*, *Title (A-Z)*,
  *Title (Z-A)* and *Author (A-Z)*.
- **Grid View** and **List View** change the layout. List view adds columns for
  *Title & Author*, *Storage*, *Progress*, *Size*, *Added* and *Actions*.

To search *inside* documents instead, use the companion panel's **Search** tab —
see [Reading ▸ Searching](reading.md#searching-inside-documents).

---

## Document details

Click the **⋯** button on a card (*More document actions*) to open its details,
which show **Storage Mode** (*Managed Copy* or *Link in Place*), **File Size**,
**Page Count**, **Storage Health**, **Reading Progress** and, for a captured
article, its **Source**.

The actions menu there offers **Move...**, **Remove from folder** (*Move this
document out of its folder; it stays in the library*) and **Delete**.

---

## Removing a document

**Delete Document** removes the document and its annotations from Interleaf.

- For a **Managed Copy**, Interleaf's copy is removed. Any original you imported
  from is untouched.
- For a **Link in Place** document, your file on disk is not deleted — only
  Interleaf's record of it.

---

## When an import fails

| Message or symptom | What it means |
| --- | --- |
| *Unsupported file extension: …* | The extension is not one of the nine listed above. |
| *This document appears to be DRM-protected and cannot be opened by Interleaf.* | The book is protected. Interleaf does not remove DRM. |
| An encrypted PDF fails to open | Password-protected PDFs are surfaced as a reader error; no password is stored. |
| A web import is refused | The address must be a public `http://` or `https://` page. |

More help: [Help and troubleshooting](help-and-troubleshooting.md#importing-and-opening).

---

Next: [Document formats](formats/README.md) ·
[Reading a document](reading.md) · [App navigation](navigation.md)
