# ADR 0006: Document Retrieval & Context Strategy

## Status
Accepted

## Context & Problem Statement
Users need to ask questions about active documents ranging from short essays to 1,000-page textbooks. AI models have finite context windows and associated token costs. Blindly dumping entire large documents into every prompt causes token overflow, high latency, and loss of attention. Conversely, relying purely on heavy vector databases introduces heavyweight external native dependencies, large model downloads, and non-deterministic retrieval.

## Decision Drivers
- Fast, local-first, zero-external-download retrieval for offline reading.
- Support for explicit user context selections (pinned highlights, page ranges).
- Verifiable provenance: AI responses must cite exact source passages with clickable navigation chips.
- Prompt injection defense: Untrusted document text must not hijack AI instructions.

## Considered Options
1. **Option 1: Heavyweight Local Vector DB** — Require bundling Chroma/Qdrant and a 500MB+ local embedding model. (Rejected for MVP: Excessive download size, CPU overhead, complex native rebuilds).
2. **Option 2: Naive Full-Document Dumps** — Always send the entire document. (Rejected: Fails on documents exceeding context limits).
3. **Option 3: Multi-Tier Context Strategy with SQLite FTS5 Lexical Retrieval** — Dynamic priority ladder combining explicit context chips, full document ingestion when within token budget, and SQLite FTS5 chunk retrieval with structured provenance XML.

## Decision Outcome
Chosen **Option 3**.

### Context Assembly Priority Ladder
```
┌────────────────────────────────────────────────────────┐
│ Level 1: Explicit Context (Highest Priority)           │
│ • Selected highlight passage                           │
│ • Explicit page range (e.g. Pages 42–45)               │
│ • Explicitly pinned whole document, up to 80% of the   │
│   window; larger pins fall back to nearby context      │
├────────────────────────────────────────────────────────┤
│ Level 2: Full Document Ingestion (automatic)           │
│ • Used if total document tokens <= 60% context window  │
├────────────────────────────────────────────────────────┤
│ Level 3: Lexical FTS5 Retrieval                        │
│ • Retrieve top-k lexical chunks from SQLite FTS5       │
│ • Ranked by BM25 match + heading match + page proximity│
└────────────────────────────────────────────────────────┘
```

### Explicitly Pinned Whole Documents That Do Not Fit
A reader may pin the whole document (level 1) for a document far larger than the chosen model. Whole inclusion is authorized only when the indexed estimate is at most **80%** of the effective context window (`CHAT_EXPLICIT_FULL_DOCUMENT_RATIO`) **and** the exact packed request — system prompt, question, replayed history or stored summary, response reserve, safety headroom, per-source serialization and the source-count limit included — still fits. The 80% figure is a gate on the indexed estimate only; it never authorizes exceeding a real limit.

Otherwise the turn is not blocked and the document is not sent whole. The builder assembles a bounded **nearby context**: an ordinal band centred on the reader's send-time location (falling back to the location recorded on the attachment), expanded outward to the chunks before and after it, packed until the next chunk no longer fits. The band is contiguous, ordered by document position in the final envelope, and capped by the same per-request source limit as every other path. For formats without pages the equivalent ordered chunks are used, under the identical budget. The turn carries a `nearby_context_only` disclosure, and the UI says only context near the reader's current position was included.

### Provenance XML Structure & Citation Chips
All context chunks sent to AI models are produced by a real XML or JSON serializer from typed values. Titles, attributes, headings, and document text are escaped as data; string concatenation is forbidden:
```xml
<document title="Designing Data-Intensive Applications" format="pdf">
  <source id="src-1" page="42" heading="Chapter 5">
    Leader-based replication requires all writes to be sent to a single leader node...
  </source>
</document>
```
The model is instructed to cite request-local source IDs (for example, `[src-1]`). The renderer converts citations into interactive UI chips (e.g. `[p. 42 • Chapter 5]`) that scroll the reader to the exact passage when clicked.
Only source IDs present in the exact sent envelope become navigation chips; unknown or malformed citations remain inert text. Permission enforcement remains in application code, never in prompt framing.

## Consequences
- **Positive**: Lightweight, completely offline, and works instantly with zero embedding model downloads.
- **Positive**: Verifiable citations allow readers to verify AI answers against the original text.
- **Negative**: Semantic retrieval based on dense embeddings is deferred to a future optional plugin.
