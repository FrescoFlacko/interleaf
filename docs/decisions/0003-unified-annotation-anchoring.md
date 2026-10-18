# ADR 0003: Unified Annotation Anchoring & Multi-Stage Resolution

## Status
Accepted

## Context & Problem Statement
User annotations (highlights, highlight notes, page notes, bookmarks) must remain permanently attached to their exact textual locations across application restarts, font size adjustments, window resizing, zoom level changes, reading palette switches, and minor document content edits. Relying solely on volatile DOM element IDs or absolute pixel coordinates causes annotations to disappear or drift.

## Decision Drivers
- High annotation reliability and zero data loss across layout reflows and typography updates.
- Support for format-specific native anchors (PDF bounding quads, EPUB CFI, MOBI byte offsets, DOCX semantic paragraphs).
- Automatic re-anchoring resilience when primary coordinates fail.
- Graceful degradation that preserves user notes even if the visual anchor cannot be found.

## Considered Options
1. **Option 1: Pixel Coordinate Anchoring** — Store raw X/Y coordinates on rendered pages. (Fails completely on reflowable EPUB/DOCX and window resizing).
2. **Option 2: Pure Text Offset Anchoring** — Store character offset from start of file. (Fails when binary container or markup changes).
3. **Option 3: Redundant Multi-Stage Anchoring** — Store format-specific anchor plus contextual text quotes (exact quote, prefix, suffix), resolved via a 4-stage fallback pipeline.

## Decision Outcome
Chosen **Option 3**.

### Anchoring Data Structure
```typescript
export interface BaseAnchor {
  exactQuote: string;
  prefixText: string;
  suffixText: string;
}

export type DocumentAnchor =
  | (BaseAnchor & { format: 'pdf'; pageIndex: number; quads: Array<{ x: number; y: number; width: number; height: number }> })
  | (BaseAnchor & { format: 'epub'; cfi: string; spineHref: string; progression: number })
  | (BaseAnchor & { format: 'mobi'; sectionIndex: number; byteOffset: number; progression: number })
  | (BaseAnchor & { format: 'docx'; paragraphIndex: number; characterStart: number; characterEnd: number; renderedPageIndex?: number });
```

### Multi-Stage Resolution Pipeline
1. **Stage 1 (Exact Match)**: Resolve stored CFI, bounding quads, or paragraph index.
2. **Stage 2 (Prefix-Quote-Suffix Match)**: Search local document section for exact `prefix + exactQuote + suffix`.
3. **Stage 3 (Fuzzy Match)**: Apply tokenized Levenshtein distance matching (threshold > 0.85) to handle hyphenation/whitespace shifts.
4. **Stage 4 (Graceful Fallback)**: Mark annotation as `status: 'unanchored'`. Display in sidebar as *"Annotation location could not be restored"*; never delete user note content.

## Consequences
- **Positive**: Highlights survive font resizing, reflows, and zoom changes without loss.
- **Positive**: Standalone page/location notes and bookmarks are supported uniformly.
- **Negative**: Adds slight overhead during initial document load to resolve multiple anchors.
