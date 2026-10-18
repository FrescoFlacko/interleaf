# Interleaf — Test Strategy & Verification Matrix

> **Read. Think. Build.**  
> Multi-Tiered Testing Pyramid, Zero-Cost Deterministic CI, Adversarial Security Matrix, and E2E Workflows.

---

## 1. Multi-Tiered Testing Pyramid

Interleaf enforces rigorous automated testing across all architectural boundaries:

This is a test map, not a substitute for release acceptance. The current
verified snapshot reports `npm test` (248 files, 3422 tests) all passing, and
199 Playwright Electron E2E entries of which 167 run and 32 are capture specs
gated off by default. `npm run lint`, `npm run typecheck`, and `npm run build`
are tracked as green gates, and the non-gated Electron suite is green at this
snapshot (`--workers=1 --retries=0`: 167 passed, 32 skipped). Signed packaging,
notarization, and cross-platform release checks remain separate gates and are
not implied by this snapshot.

```
                            ┌────────────────────────┐
                            │  Playwright E2E Tests  │
                            │  Electron App Lifecycle│
                            │  12 Core User Workflows│
                            └───────────┬────────────┘
                                        │
                            ┌───────────▼────────────┐
                            │ Adversarial Sec Tests  │
                            │ Path Traversal, Shell  │
                            │ Injection, CSP, IPC    │
                            └───────────┬────────────┘
                                        │
                            ┌───────────▼────────────┐
                            │ UI Component Tests     │
                            │ React Testing Library  │
                            │ Toolbars, Chips, Diffs │
                            └───────────┬────────────┘
                                        │
                            ┌───────────▼────────────┐
                            │ Vitest Unit & Domain   │
                            │ Anchoring, SQLite Repos│
                            │ Budgeter, Tokenizer    │
                            └────────────────────────┘
```

---

## 2. Zero-Cost Deterministic Testing Principle

- **No Live API Spend**: Normal unit, integration, and CI tests NEVER call live OpenAI, Anthropic, or OpenRouter APIs.
- **`FakeAIProvider`**: Emulates streaming token emission, cancellation handling, context ingestion, and citation tagging deterministically.
- **`FakeAgentAdapter`**: Executes test-local Node.js/shell scripts to emulate agent execution, stdout/stderr streams, file creations, test runs, and exit codes.

---

## 3. Document Fixtures

Small, generated or public-domain fixtures required under `tests/fixtures/` before reader phases pass:
- `tests/fixtures/sample.pdf`: Minimal 3-page PDF with text layer, headings, and outline.
- `tests/fixtures/sample.epub`: Minimal EPUB 3 package with reflowable chapters and TOC.
- `tests/fixtures/sample.mobi`: Minimal PalmDOC/MOBI archive.
- `tests/fixtures/sample.azw3.base64`: Calibre-generated PalmDOC-compressed KF8/AZW3 fixture from original test text; exercises real KF8 section/index/FDST parsing.
- `makeDocxFixture`: Generated OOXML Word package with styled headings, inline emphasis, alignment, lists, tables, explicit page breaks, relationships, and a real signature-valid raster.
- `tests/fixtures/raster-fixtures.ts`: Genuinely decodable PNG bytes generated at chosen dimensions across RGB, RGBA, grayscale, and indexed color with valid palettes, decodable PNGs with `tRNS` transparency across indexed, grayscale, and truecolour modes, plus hostile and adversarial counterparts — CRC-valid indexed PNG with an empty PLTE (adversarial reproduction 1), 28-byte JPEG with SOF/SOS/EOI lacking DQT/DHT tables (adversarial reproduction 2), excessive palettes across indexed bit depths 1, 2, 4, 8 (`paletteEntries > 2 ** bitDepth`), malformed `tRNS` chunks, an inflating PNG (~53,689 input bytes re-encoding to ~12,004,028 bytes) testing per-file and parallel aggregate bounds, headers with no raster behind them, headers that lie about dimensions, corrupted and truncated PNGs, and malformed non-Adam7 interlaced data, animated (`acTL`) PNGs and multi-picture JPEGs, payloads appended after valid images, GIF/WebP/AVIF headers including an AVIF with an early `ispe` claiming 20,000×20,000, SVG served as `image/png`, declared types disagreeing with magic bytes, under-minimum and over-maximum images, and byte-budget exhausters.
- `tests/fixtures/raster-animation-fixtures.ts`: Assembled borderline containers for the structural pre-admission walk — a one-frame animated WebP (`VP8X` animation bit with a single `ANMF`), the same container with the animation bit cleared but `ANIM`/`ANMF` present, a multi-picture WebP with two image chunks, a looping single-frame GIF (`NETSCAPE2.0` extension), an AVIF sequence by `avis` branding or by a `moov` box, an AVIF whose `mdat` is declared through a 64-bit largesize (accepted by the walk, overrunning variants refused), a decodable PNG whose text chunk merely mentions `acTL` (not animation), junk before a fake PNG IEND and a fake trailing JPEG EOI, plus TIFF and PDF headers no approved format may borrow.
- `tests/fixtures/raster-format-fixtures/*.b64`: Still containers produced once by the pinned encoder and stored as base64 — real static and progressive JPEG, static and animated GIF, static and animated WebP, static AVIF, and a genuine sharp-generated Adam7-interlaced PNG — so the admission walks and the isolated worker run against true encoder output for every still shape, valid and hostile alike.
- `tests/fixtures/astra-article-fixture.ts`: An invented benchmark-article page in the shape of the one that motivated ADR 0012's rich capture, not a copy of it. Supplies HTML with two representative seven-column table variants (`<thead>` and inferred strong-emphasis first row), a linked cell, a cell containing a literal `|`, an editorial raster figure with `figcaption`, `<base>`/relative/`srcset` candidates, a canvas hero with an Open Graph raster fallback, captioned video and interactive figures, and excluded chrome/icon/tracking images. It also generates the pre-slice flattened Markdown rendering of the same content, so the before/after comparison is two renderings of one article. No automated test resolves a hostname or requests the public URL.

EPUB unit coverage also exercises full package/content CFI indirection, canonical point/range round trips, spine ordering, escaped assertions, `FILTER_SKIP` text-offset preservation, strict wrong-namespace/duplicate encryption metadata classification, stale StrictMode lifecycle races, and superseded inflation cancellation. Archive adversarial coverage calls the same inflation core used by the production worker and verifies pre-inflate bomb and path-traversal rejection.

MOBI/KF8 coverage includes a real Calibre-generated PalmDOC/KF8 fixture plus synthetic malformed HUFF/CDIC and mutated real TAGX/FDST cases. Unit tests exercise the actual HUFF per-record expansion guard, cumulative decoded-length guard, hostile markup, invalid raster signatures, per-resource/aggregate raster caps, the KF8 `kindle:embed` materialization branch, and superseded/closed parse cancellation. The production-worker Electron workflow verifies hostile markup sanitization, safe MOBI6 raster materialization, cancellation of an active large parse, real KF8 text/TOC rendering, and exact within-section scroll persistence/restoration for EPUB and MOBI. A real KF8 `kindle:embed` raster fixture is not yet present, so that branch is unit-covered but not claimed as end-to-end coverage.

DOCX coverage exercises both browser DOM and the exact worker-side LinkeDOM namespace behavior. Unit/adversarial cases cover semantic headings/tables/runs, inherited styles, ordered/unordered nested/restarted Roman and alphabetic numbering, TOC, Unicode-folded search offset maps, exact paired range restoration, near-aggregate-limit absent-query cancellation by bounded text work, page/table work splitting, extraction without offset-changing trim, missing-root/DTD/malformed XML and encoding rejection, character-reference-hidden macros, conventional and arbitrary-target ActiveX/OLE relationships, actual external-image inertness, traversal/duplicate/bomb limits, raster signature and decoded-geometry checks, DOMPurify, and superseded parse cancellation. `tests/e2e/docx-reader.spec.ts` crosses the real production worker boundary and verifies import metadata, responsive rendering, TOC navigation, safe drawings, typography controls, bounded live page content while jumping through a 20-plus-page document, exact character-range derivation and geometry restoration from inside a long wrapped paragraph, termination plus worker-slot recovery after an active 30,000-paragraph parse, and production annotation creation/painting/editing/restart persistence.

---

## 4. Adversarial Security Verification Matrix

```
┌────────────────────────┬──────────────────────────────────────────┬────────────────────────────────────────┐
│ Security Test Category │ Test Input / Vector                      │ Expected Pass Condition                │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ Path Traversal         │ `interleaf-media:///%2e%2e%2f/etc/passwd`│ Main process returns HTTP 403 / rejects│
│                        │ Working directory: `../../../../`        │ Path canonicalization blocks escape    │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ Shell Injection        │ Prompt containing: `; rm -rf /`          │ Process spawned with `shell: false`;   │
│                        │ Model name containing: `$(whoami)`       │ Treated strictly as literal text data  │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ Prompt Injection       │ PDF containing: "Ignore system prompt"   │ System prompt retains authority;       │
│                        │                                          │ Model treats text as passive citation  │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ XSS & CSP              │ EPUB/DOCX script-like content and event attributes │ DOMPurify strips active markup; text remains inert │
│                        │ `<img src=x onerror=...>`                │ Script tag & event handlers stripped   │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ IPC Schema Tampering   │ Malformed payload sent to `annotations.*`│ Zod schema validation throws error;    │
│                        │ Invalid UUID or missing fields           │ Main process rejects invalid call      │
├────────────────────────┼──────────────────────────────────────────┼────────────────────────────────────────┤
│ Hostile Article Media  │ SVG served as `image/png`; declared type │ Image is rejected on magic bytes and   │
│                        │ disagreeing with magic bytes             │ omitted; alt text and caption remain   │
│                        │ Image URL resolving to a private address │ Address policy rejects before connect  │
│                        │ Redirect chain into a private address    │ Per-hop re-validation refuses the hop  │
│                        │ Oversized/over-dimension/zero-pixel image│ Byte, dimension, and pixel caps reject │
│                        │ Header with no raster, or one that lies  │ Full decode validation rejects; only   │
│                        │ about the raster behind it               │ decoder-reported geometry is used      │
│                        │ Animated image (any format), appended    │ Rejected; one frame of an animation is │
│                        │ trailer, one-frame WebP/AVIF animation   │ never archived as if it were the image │
│                        │ Twelve 8 MB failures behind a 24 MB cap  │ Streaming allowance stops each body;   │
│                        │                                          │ failures are charged what they moved   │
│                        │ More images or bytes than the budget     │ Article imports with images omitted,   │
│                        │                                          │ never truncated or partially written   │
└────────────────────────┴──────────────────────────────────────────┴────────────────────────────────────────┘
```

---

## 5. End-to-End Workflow Evidence (A–L)

The following matrix maps intended Electron Playwright coverage to source test
names. Test names are quoted from the source so this document does not overstate
which workflow a test exercises. A row is not evidence that the test passed on
the current host; format-specific tests cover persistence and restart behavior
where listed.

| Workflow | Evidence in the repository | What the assertions prove |
|:---|:---|:---|
| **A — PDF ingestion, navigation, annotation** | `tests/e2e/pdf-reader.spec.ts` — `imports PDF into library, opens in reader, navigates pages, navigates TOC outline, zooms, toggles focus mode, and returns to library` | Imports a real generated PDF, renders text/canvas layers, creates a highlight and selected/location notes, restores them after restart, jumps to the annotation, navigates pages/TOC/zoom/focus, and returns to the library. |
| **B — EPUB reflow and anchor recovery** | `tests/e2e/epub-mobi-reader.spec.ts` — `imports EPUB into library, opens in reader, navigates chapters, TOC outline, zooms, and restores reading position`; `creates a reflowed EPUB highlight and restores its CFI anchor after restart` | Exercises a real reflowable iframe, typography changes, reading-position persistence, CFI-backed highlight paint, and restart restoration. |
| **C — MOBI navigation and bookmark** | `tests/e2e/epub-mobi-reader.spec.ts` — `imports MOBI into library, opens in reader, navigates sections, and restores reading position`; `restores a MOBI bookmark after restart and jumps to its exact section` | Imports the real MOBI fixture, navigates sections, persists a bookmark, restarts, and verifies the exact section jump. The same file also covers real KF8/AZW3 rendering. |
| **D — DOCX search and annotation recovery** | `tests/e2e/docx-reader.spec.ts` — `indexes DOCX text, jumps from search provenance, and persists a note across restart` | Waits for the production index, jumps from a provenance result, creates an anchored note, restarts, and jumps back to the semantic paragraph. |
| **E — AI from highlight and citation jump** | `tests/e2e/ai-chat-workflows.spec.ts` — `Workflow E: Ask AI from Highlight & Clickable Citation Jump` | Uses the deterministic fake provider, verifies selected context and streamed response, and follows a citation back to the reader. |
| **F — explicit page-range AI context** | `tests/e2e/ai-chat-workflows.spec.ts` — `Workflow F: Explicit Page Range AI Context (Pages 42–45)` | Adds the requested page-range context, sends the question through the fake provider, and asserts the bounded context/response behavior implemented by the app. |
| **G — multi-session chat persistence** | `tests/e2e/ai-chat-workflows.spec.ts` — `Workflow G: Multi-Session Chat Switcher & Persistence across Restart` | Creates and switches sessions, sends messages, restarts, and verifies session/message persistence. |
| **H — isolated worktree review/apply** | `tests/e2e/workflows.spec.ts` — `Workflow H reviews and applies an isolated Git worktree, then discards a second run` | Runs the fake agent in an isolated Git worktree, observes the stream and diff, applies the reviewed change, and discards a second run. |
| **I — active-environment confirmation** | `tests/e2e/workflows.spec.ts` — `Workflow I requires native main confirmation and reports direct active-workspace changes` | Verifies the high-risk confirmation path, runs the fake fixture with a main-issued grant, and reports direct workspace changes. |
| **J — focus reading mode restoration** | `tests/e2e/workflows.spec.ts` — `Workflow J restores a real reader workspace exactly after Focus Mode` | Enters focus mode from a real reader workspace and asserts the prior panels, widths, tab, focus, and reader state are restored. |
| **K — resumed agent lifecycle boundary** | `tests/e2e/workflows.spec.ts` — `resumes through Electron IPC, keeps Stop live, copies native clipboard, and opens the prepared folder` | Crosses renderer → preload → main for Resume, verifies cumulative history keeps Stop active during the resumed run, copies the exact final report through Electron’s native clipboard, and opens the session’s main-owned isolated workspace. |
| **L — custom Expert Shell persistence** | `tests/e2e/workflows.spec.ts` — `creates, runs, and rehydrates a custom Expert Shell profile through the desktop UI` | Creates an Expert Shell profile through the Settings UI and native executable-picker boundary, runs its deterministic POSIX command in a selected isolated directory, verifies stdout/completion, then restarts the same user-data store and verifies the profile remains selectable. |

Rich web-article capture (ADR 0012) is covered by
`tests/e2e/web-article-rich-content.spec.ts`, driven entirely by locally
registered fixtures: `captures tables and editorial images, and paints them from
managed storage` (seven-column GFM tables, decoded pixels behind
`interleaf-media:` capabilities, preserved captions for omitted interactive
material, no remote URL anywhere in the DOM, and zero outbound renderer
requests); `keeps tables reachable at a narrow width and 200% zoom` (each table
scrolls itself while the article column does not, no image escapes the column,
and an overflowing table is a focusable named region that the arrow keys
actually scroll sideways and back);
`reopens with its images after a restart with no fixtures registered`
(offline reopen from managed storage alone); `re-importing the same URL upgrades
the capture and keeps its annotations` (one row, same ID, annotations intact);
`keeps search, annotation anchoring, and AI context working over the captured
tables`; and `shows the previous flattened capture beside the rich one`, which
imports the pre-slice rendering of the same article and captures the before/after
visual evidence at normal width, 720px, and 200% zoom into
`screenshots/web-article-rich-content/`.

Image completeness for those captures is covered off Electron, because the
failures were arithmetic and DOM decisions rather than desktop behaviour.
`tests/unit/web-article-image-reconciliation.spec.ts` runs the real extraction
worker over `tests/fixtures/split-keyboard-article-fixture.ts` — an invented
illustrated build guide in the shapes readability scoring handles worst — and
asserts that the seven editorial figures it drops come back in document order
with their captions, their alt text, and the widest rendition of a responsive
figure, while comment avatars, share icons, trackers, promo thumbnails, SVG, and
interactive media stay out and the whole thing stays inside the IR's image
bound. It also covers the cases the shapes above can hide: a site-header
photograph with an editorial filename and real alt text, which only its position
can refuse; a hero in the article's own `header`, which must survive; repeated
and prefix-colliding paragraphs, where placement has to take the next occurrence
rather than whichever the array search reaches first; four identical surviving
paragraphs with a figure belonging after the third and no unique following
anchor, which only the recorded occurrence ordinal places correctly; a page past
the image ceiling, which reports a bounded count of what it dropped and never
the URLs; and a page offering more images than ten times the archive bound,
which still reports `archived + omitted` equal to every candidate extraction
recognized rather than a saturated count.
`tests/unit/article-media.spec.ts` covers the archive bound and the accounting:
an article archiving well past the first dozen figures, an explicitly lower
count cap whose truncated candidates are counted as omitted and never requested,
the `archived + omitted === candidates` partition holding across a failed
request while `requested` deliberately overlaps it, two URLs holding one picture
counting as two archived candidates, and a phase deadline that returns a partial
result, aborts the request in flight, and counts the queue.
`tests/unit/web-article-media-deadline.spec.ts` runs the import service to prove
the same deadline yields a readable partial snapshot with complete omission
accounting, while a page that never arrives, a reader who cancels, and an image
address the policy forbids all stay fatal.
`tests/unit/web-article-import-summary.spec.ts` drives the real preload bridge
with a stub channel to prove the completeness summary crosses as two bounded
counts, that the bounds are the real per-article ceilings, and that a summary
carrying a URL, a host, or a failure reason is dropped without costing the user
the import. `tests/integration/web-article-media.spec.ts` adds the end-to-end
case: an article with 52 ordinary editorial figures archives 40, reports 12
omitted, and never requests the rest; an article with 480 figures, whose
overflow bytes are deliberately unregistered so any request would fail, still
reports 40 archived and 440 omitted through the IPC-visible summary, with no
overflow URL anywhere in the snapshot; a library with no media transport reports
every candidate omitted while making no request at all.
`tests/renderer/web-article-import-message.spec.ts` covers the sentence the
reader actually sees, including that it names no host, address, path, or reason.
`tests/integration/web-article-media.spec.ts` checks the same counts end to end
through the library service, for a complete capture, for one whose byte budget
ran out, and across a re-import that upgrades in place.

Supporting Electron coverage lives in `smoke.spec.ts`, `library.spec.ts`, and the
remaining reader/worker tests. Unit and integration security evidence is mapped
below; a workflow row does not imply live provider, signed-package, or
cross-platform testing.

## 6. Required Boundary and Persistence Integration Tests

- **Automatic isolation**: omitted/`auto-isolated` mode resolves Git → worktree and non-Git → copy; preparation failure never falls back to active environment. Renderer-supplied packet paths/bypass fields are schema-rejected; direct-workspace confirmation grants are single-use and bound to mode, target, profile fingerprint, and effective permission policy; native-restricted additionally requires verified adapter capability.
- **Workspace lifecycle**: dirty primary tree, base-commit drift, untracked collisions, symlink escapes, concurrent apply, failed preflight, atomic directory-copy rollback, idempotent discard, and abandoned-startup cleanup.
- **SQLite/FTS5**: migrations/checksums, v8 annotation and v9 index-revision backfills, foreign keys/cascades, document/capability ownership isolation, cumulative generation bounds, retained published-index visibility, stale generation/revision rejection, safe MATCH query construction, revision-bound hit resolution, trigger synchronization, FTS integrity-check/rebuild, interruption recovery, and atomic staging publication.
- **Media protocol**: opaque IDs, sibling-prefix path, encoded traversal, symlink escape, stale/cross-document IDs, MIME allowlist, cancellation, bounded stalled streaming, byte ranges without whole-file buffering, and platform-appropriate pathname-replacement checks.
- **Web-article rich capture**: table extraction (document order, `<thead>` and inferred strong-emphasis headers, preserved cell links, deterministic paragraph fallback for rowspan/colspan, over-budget tables, and an over-decorated cell that must not fail the whole article), GFM rendering and pipe/backslash/newline escaping round-tripping through the production Markdown parser (including a literal backslash inside a code cell), an overflowing table wrapper that is focusable, named, and keyboard-scrollable while it overflows, search and AI-context text that carries image alt text but no durable `interleaf-asset:` reference, image candidate selection (`src`, bounded `srcset`, lazy attributes, `<base>` and relative resolution, chrome/icon/tracking/decorative exclusion, Open Graph hero fallback, preserved captions for omitted interactive figures), media transport validation against the shared address policy, full-payload raster admission (valid still PNG/JPEG/WebP/GIF/AVIF accepted, including a genuine Adam7-interlaced PNG and a progressive JPEG; header-only, lying-header, corrupt, truncated, malformed-interlaced, animated, multi-picture, and trailered bytes refused), per-file and aggregate budgets enforced while a body streams — with an allowance smaller than the client cap, repeated oversized failures charged for what they moved, and a per-image deadline that is the earlier of the two — per-image omission versus fatal admission failure, content-hash deduplication, `document_assets` persistence, re-import upgrade preserving document ID and annotations while replacing snapshot and assets atomically, orphan-only cleanup after a successful replacement, staged media reclaimed in the hash-duplicate, insert-race, and failed-capture branches, an injected upgrade failure leaving the previous row, snapshot, asset rows, annotations, and files exactly as they were, and capability revocation on close, delete, and upgrade.
- **AI framing**: closing-tag text, hostile attributes/headings, unknown citation IDs, explicit-context overflow notification, bounded recent-history selection (the current builder does not summarize old history), prompt budget reserve, and secret absence.
- **Agent processes**: shell-metacharacter fields remain argv data, minimal environment excludes seeded fake secrets, Windows/POSIX tree cancellation, timeout, output caps, backpressure, and redaction.
- **Custom profiles**: Settings CRUD, executable identity revalidation, v11
  persistence columns/config version, whole-token placeholders, stdin/temp-file
  delivery, stale prompt cleanup, bounded non-secret environment overrides, and
  strict normal-mode rejection of shell-only configuration. Expert Shell is a
  separately gated path with dedicated creation/transition warning and fresh
  critical confirmation on every start/resume.

## 7. Accessibility and Visual Gates

- Run axe (or equivalent automated rules) on library, reader, annotation, chat, agent composer/diff, settings, and every modal/popover state.
- Keyboard-only tests cover focus order, visible focus, selection toolbar actions, modal focus trap/return, panel resizing, Focus Mode enter/exit restoration, and Escape precedence.
- Test accessible names, live-region announcements for streaming/indexing/agent status, non-color highlight/risk cues, reduced-motion behavior, 200% UI zoom/reflow, and screen-reader landmarks.
- Compute contrast for every semantic token pair—not only reader background/body text—across Paper, Sepia, Moss, Ocean, Graphite, and Midnight. Fail AA regressions in CI.
- Manual milestone evidence covers VoiceOver on macOS and at least one Windows/Linux screen reader before release.
