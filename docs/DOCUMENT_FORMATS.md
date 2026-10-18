# Interleaf — Document Formats & Reader Engine Specification

> **Read. Think. Build.**  
> Engine Adapters, Ingestion Pipeline, Viewport Virtualization, and Format-Specific Anchoring.

---

## 1. Supported Document Formats Overview

Interleaf provides first-class support for six document formats (PDF, EPUB, MOBI/KF8, DOCX, PPTX, Markdown) through decoupled reader engines; PPTX reuses the DOCX engine (§D2).

Every supported format can also be opened without adding it to the library (File ▸ Open…, Cmd/Ctrl+O, the header Open file control, or the operating system's *Open With*). Extensions are matched case-insensitively and the same validation as import applies; the file is read from a private staged copy and the original is never modified (ADR 0014).

Across every format, interactive media is permanently unsupported. Audio,
video, executable embeds, frames, forms, and document-supplied canvas programs
are removed or rejected and never receive a reader capability. Original files
may remain intact as opaque source data; inert text/captions and ordinary images
continue under the existing format-specific policies.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        UNIFIED DOCUMENT ADAPTER                                        │
│                        src/renderer/features/reader/types.ts (DocumentAdapter)                         │
├─────────────────────┬─────────────────────┬────────────────────┬───────────────────────┬───────────────┤
│ PDF Adapter         │ EPUB Adapter        │ MOBI Adapter       │ DOCX Adapter          │ Markdown      │
│ `pdfjs-dist`        │ `foliate-js`        │ `foliate-js`       │ Direct hardened OOXML │ Native Reader │
├─────────────────────┼─────────────────────┼────────────────────┼───────────────────────┼───────────────┤
│ Fixed / Paginated   │ Reflowable / Paged  │ Reflowable / Paged │ Reflowable Word Flow  │ Reflow Flow   │
│ Canvas + TextLayer  │ Sanitized DOM Flow  │ Sanitized DOM Flow │ DOM Document Flow     │ Sanitized DOM │
│ Bounding Quads      │ EPUB CFI            │ Section + Byte Pos │ Semantic Para + Range │ Block + Range │
└─────────────────────┴─────────────────────┴────────────────────┴───────────────────────┴───────────────┘
```

---

## 2. Format Specifications & Reader Implementations

### A. PDF (`.pdf`) — Fixed Layout Engine
- **Engine**: Mozilla PDF.js (`pdfjs-dist`).
- **Rendering Architecture**:
  * **Viewport Virtualization**: Large documents use lightweight page placeholders, while only the currently visible pages and an overscan buffer of $\pm 2$ pages own active canvas/text layers. Off-screen page layers are destroyed to conserve GPU and heap memory; the verified performance fixture exercises a 50-page document.
  * **Dual-Layer Rendering**: Each page consists of a canvas layer for graphic rendering and a transparent SVG/HTML `TextLayer` overlay for native text selection, search highlighting, and annotation anchoring.
- **Outline & Metadata**: Extracted via `pdfDoc.getOutline()` and `pdfDoc.getMetadata()`.
- **Security Hardening**: PDF.js 6 runs without a scripting manager or annotation layer; XFA and annotation rendering are explicitly disabled, remote origins are blocked by CSP, and image/canvas allocations are capped. Embedded document actions are never executed by Interleaf.
- **Password Protection**: The current slice surfaces encrypted PDFs as a reader error and never persists a password. An ephemeral password prompt may be added later through PDF.js's supported password callback.

### B. EPUB (`.epub`) — Reflowable Ebook Engine
- **Engine**: Vendored hardened subset of `foliate-js` (pinned upstream commit
  `78914aef4466eb960965702401634c2cb348e9b1`, MIT; see
  `src/renderer/features/reader/adapters/foliate/VENDOR.md`). The similarly
  named `foliate-js@1.0.1` npm artifact is a stale third-party publication and
  does not represent current upstream, so the audited subset is vendored.
- **Rendering Architecture**:
  * Unpacks the EPUB OCF container with fflate in a dedicated, two-slot, 30-second-bounded Web Worker under pre-inflate zip-bomb limits (entry count, single-entry and total uncompressed size) and path-traversal entry rejection.
  * Parses `container.xml` → OPF package → manifest/spine; sanitizes each spine item before assigning iframe `srcdoc`; the iframe is locked to `sandbox="allow-same-origin"` (never `allow-scripts`).
  * Reflowable scroll flow with font scale, line-spacing, margin, and palette controls. Safe internal raster images are re-served as book-scoped blob URLs; arbitrary book CSS, SVG, and remote URLs are stripped.
- **Navigation**: EPUB 3 Navigation Document and EPUB 2 NCX parsing with spine resolution; synthetic section TOC fallback. A throttled top-visible caret probe records an exact full-package CFI plus within-section progression while scrolling, and restores the precise position on reopen. Locations retain stable spine-index CFIs (`/6/2n` fake-CFI scheme) as a fallback. CFI regressions cover full package/content indirection, point/range round trips, assertion escaping, ordering, and skipped wrapper nodes.
- **Content Sanitization**: Every content document passes a strict DOMPurify policy (`foliate/sanitize.ts`) before any DOM insertion: scripts, frames/objects/embeds, form controls, `on*` handlers, `javascript:` URIs, and remote `http(s)` resource URLs are stripped.
- **DRM Policy**: Malformed `META-INF/encryption.xml`, missing encryption targets, unknown algorithms, and any target not declared as a font in the manifest fail closed. Only the two known EPUB font-obfuscation algorithms applied to manifest-declared font media are accepted. Rejected books surface *"This document appears to be DRM-protected and cannot be opened by Interleaf."* DRM circumvention is strictly prohibited.

### C. MOBI/KF8 (`.mobi`, `.azw`, `.azw3`) — PalmDOC Engine
- **Engine**: Exact pinned upstream parser core (`upstream/mobi.js`) behind a typed, hardened Interleaf wrapper (`mobi.ts`).
- **Rendering Architecture**:
  * Parses PDB headers/record list, PalmDOC and MOBI headers; rejects nonzero PalmDOC encryption flags.
  * Supports uncompressed records, PalmDOC LZ77, HUFF/CDIC, MOBI6, combo MOBI/KF8, and KF8/AZW3. Envelope, per-record and aggregate decoded output, metadata, index, dictionary, recursion, FDST, markup, and raster-resource bounds fail closed before or within upstream loops.
  * Parse/decompression, DOM reconstruction, resource extraction, and a structural allowlist prefilter run in a dedicated Web Worker, with at most two active jobs, a 30-second timeout, transferable input, and cancellation on superseding open or reader close. Queued aborted jobs are removed immediately. The worker uses pinned `linkedom@0.18.13` DOM primitives and returns bounded serialized sections/metadata under an 8 MiB section and 32 MiB book-markup cap. The renderer applies the mandatory strict DOMPurify policy lazily to the active section before `srcdoc`, then performs the same defense-in-depth check inside the scriptless frame.
  * MOBI6 `recindex` and KF8 `kindle:embed` images are materialized only when their bytes signature-match PNG, JPEG, GIF, WebP, or AVIF and remain within per-resource, per-section, and per-book limits. Sanitized sections render through the same scriptless `srcdoc` iframe as EPUB.
- **Navigation & Metadata**: Section-based TOC; import-time metadata from the PDB database name and embedded author markup. `.azw`/`.azw3` files share the MOBI signature and open through this adapter.
- **Locations**: `{ format: 'mobi', sectionIndex }` anchors with optional byte offset and precise within-section progression. Scroll relocation is persisted and restored across reader reopen.
- **DRM Policy**: DRM-encrypted records fail closed with the same user-safe error; Kindle DRM (AZW/KFX) circumvention is out of scope forever.

### D. DOCX (`.docx`) — Office Word Engine
- **Engine decision**: A renderer-owned direct OOXML pipeline replaces the provisional `docx-preview` choice. The current `docx-preview` API accepts a raw ZIP and writes directly into a live DOM, which conflicts with Interleaf's mandatory bounded-worker parsing and sanitize-before-insertion boundary. `fflate` inflates under DOCX-specific limits, `saxes` validates XML strictly, and pinned `linkedom` builds the worker-side tree.
- **Rendering Architecture**:
  * Transfers the input buffer to a dedicated parser worker. At most two jobs run concurrently; each has a 30-second timeout and is terminated on completion, failure, superseding open, or reader close. The archive is capped at 5,000 entries, 128 MiB expanded aggregate, and 32 MiB per part before inflation completes.
  * Parses `word/document.xml`, styles, numbering definitions/overrides, every relationship part, headings, paragraphs, inline emphasis, alignment, semantic ordered/unordered nested lists, tables, explicit page breaks, and safe raster drawings. Content controls are traversed and semantic paragraphs inside table cells remain individually addressable.
  * Returns only plain bounded semantic data. Renderer-owned markup is escaped, passed through the strict shared DOMPurify policy immediately before live insertion, and styled with Interleaf-owned responsive typography. Page text/node budgets split oversized tables, search yields with cancellation and a 5,000-result ceiling, and only visible/nearby derived pages retain DOM content.
  * Generates stable `data-docx-paragraph="42"` identifiers. Unicode case-folded search retains an original UTF-16 offset map; DOM `Range` geometry and caret-derived viewport offsets preserve paired `{ paragraphIndex, characterStart, characterEnd }` anchors. `renderedPageIndex` and the displayed page count are derived navigation hints, never canonical anchors.
- **Active-content policy**: Namespace-strict, character-reference-decoded content types and every relationship type are inspected. VBA projects, macro-enabled content types, ActiveX parts, embedded OLE/package objects, attached toolbars, custom UI parts, and audio/video media fail closed regardless of target filename. External relationships are never materialized. Drawings require structurally parsed, static PNG/JPEG/GIF/WebP data under compressed-byte, decoded-dimension, pixel-count, count, and aggregate budgets.
- **Layout scope**: The reader preserves semantic hierarchy, run emphasis, alignment, lists, tables, images, explicit breaks, and comfortable responsive page flow. It does not claim pixel-identical Microsoft Word pagination; font availability and viewport width can change derived page hints without changing paragraph anchors.

### D2. PowerPoint (`.pptx`) — Inert Slide Reader
- **Engine**: `PptxAdapter` reuses the DOCX paragraph reader with a `pptx` format parameter; `pptx-parse-core.ts` runs in its own dedicated worker through the shared OOXML worker pool (two concurrent jobs, 30-second timeout, terminated on close or superseding open). Only existing dependencies are used: `fflate`, `saxes`, `linkedom`.
- **Package limits**: 10,000 entries, 256 MiB expanded aggregate, 64 MiB per part, 2,000 slides, 512 KiB text / 10,000 nodes per slide, 8 MiB per image, 48 MiB of images per deck, 2,000 images. Exceeding a limit fails the open with a user-safe message.
- **What is read**: the presentation main part (required content type), `sldIdLst` order through the presentation relationships (never slide file names), and for each slide the shape tree in document order with group shapes and the `AlternateContent` fallback branch. Title placeholders come first as the slide heading; bullets (`buChar`, body placeholders), numbered lists (`buAutoNum`), list levels, run emphasis, tables (merged continuation cells skipped) and still pictures from package-internal PNG/JPEG/GIF/WebP parts.
- **What is not read**: speaker notes, masters/layouts/themes, positioned geometry, shape fills and backgrounds, charts/SmartArt drawings, transitions and animations. The reader shows slide content as semantic reading text on one widescreen page per slide; it does not claim PowerPoint visual fidelity.
- **Navigation & locations**: one TOC entry per slide (its title or `Slide N`); pages carry `aria-label="Slide N"`. Locations, anchors, search hits, chunks and citations use `{ format: 'pptx', paragraphIndex, renderedPageIndex? }` and chunk page labels read `Slide N`; a `docx` location never drives a deck.
- **Active-content policy**: macro-enabled content types, VBA projects, OLE/package objects, ActiveX controls, audio/video and every other active relationship fail closed; external relationships are never fetched. DOCTYPE/entity declarations and non-presentation packages are rejected. Encrypted Office files (OLE compound files) and non-ZIP input fail signature validation in main before any renderer parse.

### E. Markdown (`.md`) & Managed Web Article Snapshots
- **Engine**: Native reflowable Markdown adapter (`src/renderer/features/reader/adapters/markdown-adapter.ts`).
- **Architecture & Invariants**:
  * Renders sanitized reflowable Markdown with responsive typography, font scaling, reading themes, and structural navigation.
  * Anchoring uses canonical `{ format: 'markdown', blockIndex, characterStart?, characterEnd? }` locations.
  * Full-text search (FTS5) indexes semantic chunks with native character offsets and query term highlight ranges (`SearchMatchAnchor`).
  * Annotations (highlights, notes, bookmarks) and reading positions persist and restore identically across reader sessions.
  * AI chat context construction (`ChatContextBuilder`) treats Markdown documents natively, enabling whole-document inclusion and excerpt retrieval with citations without format conversion.
  * GFM pipe tables parse to table blocks and render inside a horizontally scrollable wrapper, so a wide table stays complete and reachable at narrow widths and 200% zoom without widening the reading column. While a table overflows, its wrapper is a focusable region with an accessible name, so the arrow keys can scroll it; when it fits, the wrapper is neither a tab stop nor a landmark. This applies to every Markdown document, web-captured or user-supplied.
  * Row splitting is code-span aware: an escaped `|` becomes a literal pipe, and a backslash doubled to keep it from escaping a column boundary is restored to one backslash inside an inline-code cell.
  * Images render only from `interleaf-asset:` references resolved to opaque `interleaf-media:` capabilities at open time. A Markdown document with no assets renders exactly as it did before, and no adapter path loads a remote image.
  * Search, indexed chunks, and AI context read an archived image as its alt text: the durable reference itself is omitted, so a content hash is never a search hit or a context token. Text from a document without archived images is unchanged.
- **Managed Web Article Snapshots (ADR 0012)**:
  * Web articles captured via `importWebArticle` are converted off the main thread into inert, script-free Markdown snapshots and saved to managed content-addressed library storage.
  * Carry additive, strongly-typed source provenance in `documents.source` (`DocumentSource`: `{ kind: 'web', url, siteName, capturedAt }`), verified by `documentSourceSchema` and enforced by database coherence triggers (Migration 21).
  * Semantic tables from the source page are rendered as GFM pipe tables with `|`, `\`, and newlines escaped inside cells. A table using `rowspan`/`colspan`, exceeding the extraction bounds, or holding a cell with more inline pieces than a cell may carry degrades to the ordered paragraph rendering rather than risking a mis-aligned grid or costing the reader the article.
  * Editorial images validated and archived by main appear as `interleaf-asset:<sha256><ext>` references, with their alt text and `figcaption` preserved. Only the five approved still rasters are archivable — static PNG, JPEG, WebP, GIF, and AVIF (ADR 0013) — because an isolated worker first classifies the container by bounded structural walk (exact PNG, structurally plausible JPEG, GIF87a/89a, exact RIFF/WEBP, ISOBMFF `ftyp` with AVIF still branding only), refuses animation and sequence signalling by structure (real PNG `acTL` chunks, WebP `VP8X` animation bits plus `ANIM`/`ANMF` even around one frame, looping or multi-frame GIFs, AVIF `avis` branding or `moov` boxes), and requires the first complete container to end exactly at the last byte; the pinned `sharp` (0.35.4) then fully decodes the still inside that worker and re-encodes its pixels to deterministic safe canonical PNG bytes bounded strictly by caller admission allowances. SVG, vector or active markup, and anything that failed validation are safely refused rather than sanitized. Images that were offered but not archived — SVG charts, canvas renderings, video, interactive embeds, or an unverifiable format — leave their caption and alt text behind rather than a broken reference. A canvas hero falls back to a validated Open Graph raster.
  * A snapshot may hold up to 40 archived images, which is the same bound the extraction IR validates against, so an illustrated build guide keeps its figures rather than the first dozen. Editorial figures the readability scoring pass discards — a photograph inside a shop link, a lazy or `srcset`-only figure, a hero above the body — are reconciled back into the snapshot at their document position with their captions; comment avatars, share icons, trackers, promo thumbnails, site-header chrome, and anything active or vector stay out — a site masthead's photograph is refused by where it sits rather than by what it is called, while a hero inside the article's own `header` is kept. A page offering more figures than the bound holds archives 40 and reports the rest as omitted rather than claiming a complete capture — every figure extraction recognized is either archived or counted, however many the page offers, because recognition and the omission count share one ceiling.
  * A capture that could not keep every picture says so in the import success message as a count, and only a count. The snapshot is still complete prose with every missing figure's caption and alt text in place, so this is a note on a success rather than an error.
  * The archived bytes are related to the document by `document_assets` (Migration 22); the snapshot itself never contains a remote URL or an ephemeral capability URL, which is what makes it reopenable offline and safe to hash.
  * Web snapshots reuse the existing reflowable Markdown adapter path with zero modifications to the core reader engine, enabling unified annotations, search, reading position restoration, and AI context without engine fragmentation.

---

## 3. Normalized Text Extraction & Chunking Pipeline

Every imported document undergoes background text extraction and semantic chunking to support lexical FTS5 search and AI context retrieval:

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│ Document Binary │────▶│ Parser & Text Stream │────▶│ Semantic Chunker     │────▶│ SQLite DB &    │
│ PDF/EPUB/MOBI/  │     │ (Page / Section text)│     │ (~500 tokens + ovlp) │     │ FTS5 Index     │
│ DOCX            │     │                      │     │                       │     │                │
└─────────────────┘     └──────────────────────┘     └──────────────────────┘     └────────────────┘
```

### TypeScript Data Contracts
```typescript
// src/shared/types/document.ts
import { DocumentAnchor } from './annotation';

export type DocumentFormat = 'pdf' | 'epub' | 'mobi' | 'docx' | 'markdown' | 'pptx';

export type DocumentSource = {
  readonly kind: 'web';
  readonly url: string;
  readonly siteName: string | null;
  readonly capturedAt: string;
};

export interface DocumentMetadata {
  id: string;
  title: string;
  author: string | null;
  format: DocumentFormat;
  storageMode: 'managed' | 'link';
  fileSize: number;
  fileHash: string; // SHA-256
  pageCount: number | null;
  source: DocumentSource | null; // web snapshot provenance; null for local files
  folderId: string | null;
  readingProgress: number; // 0.0 to 1.0
  lastReadLocation: DocumentLocation | null;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TableOfContentsItem {
  id: string;
  title: string;
  location: DocumentLocation | null; // null when the destination cannot be resolved
  level: number;
  children: TableOfContentsItem[]; // empty for a leaf entry
}

export interface NormalizedTextChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  location: DocumentAnchor;
  heading: string | null;
  pageLabel: string | null;
}
```

Canonical source/cover paths live only in a main-process `DocumentRecord` and never cross IPC. Renderer-facing metadata uses document IDs and scoped asset URLs. `DocumentLocation` is a Zod-validated discriminated union for PDF, EPUB, MOBI, and DOCX.

---

## 4. Format-Specific Document Anchors

To ensure annotations survive layout recalculations, zoom, and font resizing, each format produces a concrete `DocumentAnchor` variant:

```typescript
// src/shared/types/annotation.ts

export type DocumentAnchor =
  | PdfDocumentAnchor
  | EpubDocumentAnchor
  | MobiDocumentAnchor
  | DocxDocumentAnchor;

export interface BaseAnchor {
  exactQuote: string;
  prefixText: string;
  suffixText: string;
}

export interface PdfDocumentAnchor extends BaseAnchor {
  format: 'pdf';
  pageIndex: number; // 0-indexed
  pageLabel?: string;
  quads: Array<{ x: number; y: number; width: number; height: number }>; // Normalized 0..1 coordinates
  startOffset?: number;
  endOffset?: number;
}

export interface EpubDocumentAnchor extends BaseAnchor {
  format: 'epub';
  cfi: string; // EPUB Canonical Fragment Identifier (e.g. "epubcfi(/6/4[chap01]!/4/2/10)")
  spineHref: string;
  progression: number; // 0.0 to 1.0 within section
}

export interface MobiDocumentAnchor extends BaseAnchor {
  format: 'mobi';
  sectionIndex: number;
  byteOffset: number;
  progression: number;
}

export interface DocxDocumentAnchor extends BaseAnchor {
  format: 'docx';
  paragraphIndex: number;
  characterStart: number;
  characterEnd: number;
  renderedPageIndex?: number;
}
```
