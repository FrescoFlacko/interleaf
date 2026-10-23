# ADR 0014: PPTX as an Inert Slide Reader, and Opening Files Without Importing

## Status
Accepted. Both parts are implemented: the PPTX format and opening any supported file without adding it to the library.

## Context & Problem Statement
Readers want to open, annotate, search, and ask about PowerPoint decks the same way they do Word documents. They also want to read a file someone handed them — from Finder, a file manager, or the Open dialog — without it joining their library. A `.pptx` file is an OOXML package like `.docx`, but a deck is also a carrier for macros, OLE objects, ActiveX controls, audio/video, animations, and remote resources. The AGENTS invariant makes interactive document media permanently unsupported.

## Decision

### PPTX
- `pptx` is a first-class `DocumentFormat` for library import, with its own locations (`{ format: 'pptx', paragraphIndex, renderedPageIndex? }`), anchors, search chunks, and citations, so deck records never mix with Word records.
- The reader reuses the DOCX paragraph reader (`DocxAdapter` parameterized by format) rather than a second rendering engine. Each slide is one widescreen page; slide titles populate the outline; chunk page labels read `Slide N`.
- Parsing runs in a dedicated worker (`pptx-parse.worker.ts`) through the shared OOXML worker pool, using only existing dependencies (`fflate`, `saxes`, `linkedom`) and the same strict package/XML policy as DOCX, with deck-specific budgets (docs/DOCUMENT_FORMATS.md §D2).
- Only inert content is read: text, lists, tables, and package-internal still images. Notes, masters/layouts, geometry, animations, transitions, media, charts, and SmartArt are not read. Active content fails the whole open closed; external relationships are never fetched.
- Main validates `.pptx` by extension (case-insensitive), ZIP signature, safe central directory, `[Content_Types].xml`, and the presence of `ppt/presentation.xml`; a Word package renamed `.pptx` (or the reverse) is rejected. Migration v25 widens the `documents.format` CHECK.

### Opening a file without importing it
- **Entry points.** The native File menu offers *Open…* (Cmd/Ctrl+O) beside *Import to Library…* (Cmd/Ctrl+Shift+O). The operating system hands files over through `electron-builder.yml` `fileAssociations` (role `Viewer`, rank `Alternate`, never the preferred handler) for PDF, EPUB, MOBI/AZW/AZW3, DOCX, PPTX and Markdown: macOS `open-file` events (listened for at module load, so ones arriving before `ready` are queued), the launch command line, and `second-instance` command lines. Delivery focuses the existing window.
- **Main decides everything.** The renderer never sends a path. It asks main to show the Open dialog (`files:openDialog`) or to claim the file the operating system delivered (`files:openPending`); main pushes a `files:command` event (`open-dialog`, `import-dialog`, `open-pending`) for menu items and late deliveries. `OpenFileRequestQueue` keeps only the most recent request. Extensions are compared case-insensitively, and the library's import validation (regular file, size, signature, package structure) runs on the path in main, so a renamed or malformed file is refused and the current document stays open.
- **Separate, in-memory service sets.** Each opened file gets an `OpenFileStore`: its own `InterleafDatabase.open(':memory:')`, repositories, library/search/annotation/chat services, and a private staged copy under `<userData>/open-files/<store>` (mode 0700). The original is only read. `OpenFileManager` owns at most one store, serializes open/close, and routes IPC by document or chat-session ownership (`open-file-routing.ts`); everything else goes to the library's services. The shared provider registry is lent without its `shutdown`.
- **Lifetime.** Closing the reader, opening another file, opening a library document, closing the window, or quitting disposes the store: its chat streams are cancelled first, then its capabilities (asset registrations, the document) are revoked, the database is closed and the staged copy is deleted. A replacement file takes over only after it has loaded. Startup deletes anything a crashed run left in `<userData>/open-files`. Closed ids stay refused ("This document is no longer open.") so late work never falls through to the library. Opened-file ids never reach persisted state: the settings document holds no document ids, and an opened file's reading position, annotations and chats live only in its in-memory database.
- **Scope.** Reading, reading position, annotations, search and Reader AI chat work within the session. Agent Mode is refused for an opened file ("Agent Mode works with documents in your library."), because agent sessions are durable. The UI does not label the file as temporary; closing it simply leaves no trace in the library.

## Consequences
- Decks read as semantic outlines, not slide-faithful visuals. This limit is stated in docs/DOCUMENT_FORMATS.md rather than in transient UI notices.
- Chats about an opened file end with it; a reader who wants to keep one imports the file instead.
- Content already sent to an AI provider, and any logs an external CLI provider keeps itself, are outside Interleaf and are not removed by disposal.
- Any later request for visual slide fidelity (positioned layout, masters) must extend the worker's bounded data model; it must never introduce animation, media, or script execution.
