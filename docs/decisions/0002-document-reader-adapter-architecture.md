# ADR 0002: Document Reader Adapter Architecture

## Status
Accepted

## Context & Problem Statement
Interleaf supports four distinct document formats: PDF (fixed-layout paginated), EPUB (reflowable container), MOBI/AZW3 (PalmDOC/KF8 binary container), and DOCX (Word flow). The implementations use `pdfjs-dist`, a pinned hardened `foliate-js` subset, and a direct OOXML pipeline (`fflate`, strict `saxes` validation, and worker-side `linkedom`). Directly embedding format-specific logic across UI components would create massive coupling and break annotation, search, and AI context features when reader libraries evolve.

## Decision Drivers
- Universal interface for all document operations (open, close, navigate, search, anchor).
- Complete decoupling of document rendering from annotation persistence and AI context generation.
- Strict isolation of third-party reader library APIs behind Interleaf contracts.
- Support for viewport virtualization in fixed-layout PDFs and sanitized reflowable DOM in ebooks and DOCX.

## Considered Options
1. **Option 1: Ad-Hoc Component Embedding** — Render `<PdfViewer>`, `<EpubViewer>`, and `<DocxViewer>` as independent components with separate annotation and search implementations.
2. **Option 2: Unified `DocumentAdapter` Contract** — Encapsulate each reader engine behind a standard TypeScript interface implementing common lifecycle, navigation, search, and anchor serialization methods.

## Decision Outcome
Chosen **Option 2**.

### Architectural Invariants
1. **Unified Interface**: All reader engines implement `DocumentAdapter`:
   ```typescript
   export interface DocumentAdapter {
     readonly format: 'pdf' | 'epub' | 'mobi' | 'docx';
     open(containerElement: HTMLElement, documentUrl: string): Promise<void>;
     close(): Promise<void>;
     getTableOfContents(): Promise<TableOfContentsItem[]>;
     goToLocation(location: DocumentLocation): Promise<void>;
     getReadingLocation(): { location: DocumentLocation; progress: number };
     search(query: string): Promise<SearchMatch[]>;
     resolveAnchor(anchor: DocumentAnchor): Promise<{ matched: boolean; rects?: DOMRect[] }>;
     serializeSelection(selection: Selection): Promise<DocumentAnchor | null>;
     extractLocationText(location: DocumentLocation): Promise<NormalizedTextChunk>;
   }
   ```
2. **Annotation Ownership**: Reader engines NEVER persist or manage annotation records. Annotations are managed exclusively by Interleaf's central annotation store and database.
3. **DRM Policy**: Reader adapters inspect files for DRM encryption. DRM-protected files are rejected with a clear message and never bypassed.

## Consequences
- **Positive**: Adding or swapping a reader engine requires only implementing the adapter interface.
- **Positive**: Features like Kindle-style annotations, FTS5 search, and AI citations work uniformly across all formats.
- **Negative**: Requires writing adapter glue code to map engine-specific structures to Interleaf contracts.
