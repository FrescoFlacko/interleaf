# Interleaf — Unified Annotation Model & Anchoring Specification

> **Read. Think. Build.**  
> Normalized Annotation Entities, Multi-Stage Re-Anchoring, Palette Tokens, and Kindle-Style Browser.

---

## 1. Universal Annotation Model

Annotations in Interleaf are first-class domain entities managed independently from document rendering engines. Highlights, highlight notes, page/location notes, and bookmarks are normalized into a unified schema stored in SQLite.

```
┌────────────────────────────────────────────────────────────────────────┐
│                            ANNOTATION ENTITY                           │
├───────────────────┬────────────────────────────────────────────────────┤
│ id                │ UUID string                                        │
│ documentId        │ UUID foreign key -> documents.id                  │
│ documentHash      │ Document revision used to resolve the anchor      │
│ type              │ 'highlight' | 'note' | 'bookmark'                  │
│ anchor            │ DocumentAnchor (PDF / EPUB / MOBI / DOCX)          │
│ selectedText      │ Exact text content selected by user (optional)     │
│ note              │ Plain user text for notes (optional)               │
│ color             │ 'yellow' | 'blue' | 'green' | 'pink' | 'purple'    │
│ isLocationNote    │ boolean (true for standalone page/location notes)  │
│ status            │ 'anchored' | 'unanchored'                          │
│ createdAt         │ ISO-8601 UTC timestamp                             │
│ updatedAt         │ ISO-8601 UTC timestamp                             │
└───────────────────┴────────────────────────────────────────────────────┘
```

---

## 2. Annotation Types & Behavior

```
┌────────────────────────┬───────────────────┬───────────────────┬────────────────────────────────┐
│ Type                   │ Requires Text Sel │ Has User Note     │ Viewport Visual Representation │
├────────────────────────┼───────────────────┼───────────────────┼────────────────────────────────┤
│ **Highlight**          │ Yes               │ No                │ Colored text overlay           │
│ **Highlight Note**     │ Yes               │ Yes (plain text)  │ Colored text overlay + panel entry │
│ **Location/Page Note** │ No                │ Yes (plain text)  │ Anchored annotation-panel entry │
│ **Bookmark**           │ No                │ Optional Label    │ Header ribbon / margin dog-ear │
└────────────────────────┴───────────────────┴───────────────────┴────────────────────────────────┘
```

### Color Palette Tokens
Interleaf provides 5 accessible highlight colors tuned for both light and dark reading themes:

| Color Token | Hex Light (Opacity 0.35) | Hex Dark (Opacity 0.45) | Semantic Meaning / Common Usage |
|:---|:---|:---|:---|
| **`yellow`** | `#FDE047` | `#EAB308` | General emphasis / key concepts (Default) |
| **`blue`** | `#93C5FD` | `#3B82F6` | Definitions / terminology / references |
| **`green`** | `#86EFAC` | `#22C55E` | Supporting evidence / agreements / solutions |
| **`pink`** | `#F472B6` | `#EC4899` | Disagreements / counterarguments / questions |
| **`purple`** | `#D8B4FE` | `#A855F7` | Architecture / design patterns / key takeaways |

---

## 3. Robust Multi-Stage Re-Anchoring Algorithm

Document layouts shift during font resizing, window changes, zoom, or underlying file updates. Interleaf employs a 4-stage resolution pipeline to reliably re-anchor highlights:

```
┌────────────────────────────────────────────────────────┐
│               Input: Stored DocumentAnchor             │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │  Stage 1: Fast Exact      │──[Found]──▶ Render Highlight
              │  CFI / Quad / Node Match  │
              └─────────────┬─────────────┘
                            │ [Failed / Shifted]
                            ▼
              ┌───────────────────────────┐
              │  Stage 2: Contextual Text │──[Found]──▶ Update Anchor Quads
              │  Prefix + Quote + Suffix  │             & Render Highlight
              └─────────────┬─────────────┘
                            │ [Failed]
                            ▼
              ┌───────────────────────────┐
              │  Stage 3: Fuzzy Match     │──[Score > 0.85]──▶ Re-anchor to Match
              │  (normalized bigram Dice)│
              └─────────────┬─────────────┘
                            │ [Score < 0.85]
                            ▼
              ┌───────────────────────────┐
              │  Stage 4: Graceful Fallback│──▶ Mark `status: 'unanchored'`
              │  Preserve note in sidebar │     Display warning; never delete
              └───────────────────────────┘
```

### Re-Anchoring Implementation Logic

Equivalent adapter flow (pseudocode; format adapters perform the native-anchor conversion internally):

```typescript
const resolution = await resolveTextAnchor(textRoot.textContent, anchor.quote, {
  nativeRange: adapterNativeOffsets,
  priorOffset: adapterPriorOffset,
  signal,
});

// null is Stage 4; adapters keep the original anchor and emit `unanchored`.
// A match is converted back to a format-native anchor and a live DOM Range.
return resolution === null
  ? { status: 'unanchored', anchor }
  : { status: 'anchored', anchor: convertResolutionToFormatAnchor(resolution) };
```

The implemented resolver caps exact recovery at 2,000,000 characters around the prior offset and fuzzy recovery at a 100,000-character window, 4,096-character quote, and 256 candidates, yielding between batches. DOCX additionally checks at most 20 neighboring paragraphs in each direction. Fuzzy acceptance is strictly greater than 0.85. When a repair is returned, the main-process repository transactionally stores the anchor together with the document hash/revision used for repair. Duplicate quotes are ranked using prefix/suffix and distance from the prior location. Failed resolution preserves the original anchor and note and marks the record `unanchored`.

---

## 4. Kindle-Style Annotation Browser

The right-side navigation drawer provides an interactive annotation panel:

```
┌────────────────────────────────────────────────────────┐
│  Annotations (42)                   🔍 Filter... [All] │
├────────────────────────────────────────────────────────┤
│  [All (42)]  [Highlights (28)]  [Notes (10)]  [🔖 (4)] │
├────────────────────────────────────────────────────────┤
│  🟡 Page 42 • Today 14:20                         ⋯   │
│  "Distributed consensus requires a quorum of nodes..." │
│  💬 Note: Compare with Raft leader election algorithm  │
├────────────────────────────────────────────────────────┤
│  🔵 Chapter 4 • Yesterday                         ⋯   │
│  "Byzantine fault tolerance assumes arbitrary..."      │
├────────────────────────────────────────────────────────┤
│  🔖 Page 112 • Oct 12                             ⋯   │
│  Bookmark: Chapter 6 Architecture Summary              │
└────────────────────────────────────────────────────────┘
```

- **Interactive Capabilities**:
  * **Jump to Location**: Clicking an entry immediately navigates the reader viewport to the native anchor or its repaired text range.
  * **Inline Editing**: Notes can be edited directly within the sidebar.
  * **Inline Color Editing**: Highlight colors can be changed without recreating the annotation.
  * **Safe Deletion**: Deletion requires explicit confirmation and is scoped to the open document.

Search, type filtering, sorting, counts, and 50-item pages are evaluated by the main-process repository, so every persisted annotation remains reachable without mounting an unbounded card list. Reader overlays use a separate format-native scope (PDF/DOCX virtual-page overscan, EPUB spine item, or MOBI section), capped at 2,000 painted records with an explicit warning. Anchors from older document hashes are also loaded for cross-document invalid-target detection and repair.

Export is intentionally deferred; the Phase 5 bridge exposes no arbitrary filesystem destination or generic write channel.
