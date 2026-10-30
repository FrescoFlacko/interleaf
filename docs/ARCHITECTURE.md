# Interleaf — System Architecture Specification

> **Read. Think. Build.**  
> Comprehensive Technical Architecture, Process Boundaries, IPC Contracts, and Subsystem Designs.

---

## 1. System Overview & Process Model

Interleaf is structured around Electron's multi-process architecture to guarantee memory safety, process sandboxing, UI responsiveness, and strict privilege separation.

```
                                  ┌────────────────────────────────┐
                                  │      Operating System (OS)     │
                                  │ macOS / Windows / Linux        │
                                  └───────────────┬────────────────┘
                                                  │
 ┌────────────────────────────────────────────────▼────────────────────────────────────────────────┐
 │                                      MAIN PROCESS (Node.js)                                      │
 │                                                                                                 │
 │  ┌─────────────────────────┐  ┌──────────────────────────┐  ┌────────────────────────────────┐  │
 │  │    Window Lifecycle     │  │  SQLite Database Engine  │  │   Managed Library Storage      │  │
 │  │    & Native Menus       │  │  WAL Mode + Repositories │  │   userData/library + Link-in-Place │  │
 │  └───────────┬─────────────┘  └────────────┬─────────────┘  └───────────────┬────────────────┘  │
 │              │                             │                                │                   │
 │  ┌───────────▼─────────────┐  ┌────────────▼─────────────┐  ┌───────────────▼────────────────┐  │
 │  │   AI Provider Registry  │  │   Agent Process Runtime  │  │   Lexical FTS5 Search Engine   │  │
 │  │   CLI Stream / OpenRouter│  │   Spawn / Worktree / Diff│  │   Background Chunk Ingestion   │  │
 │  └───────────┬─────────────┘  └────────────┬─────────────┘  └───────────────┬────────────────┘  │
 │              │                             │                                │                   │
 │  ┌───────────▼─────────────┐  ┌────────────▼─────────────┐  ┌───────────────▼────────────────┐  │
 │  │ Secure Credential Store │  │  Path & Protocol Guard   │  │   Application Logger           │  │
 │  │ safeStorage (Keychain)  │  │  interleaf-media://      │  │   Structured & Redacted        │  │
 │  └─────────────────────────┘  └──────────────────────────┘  └────────────────────────────────┘  │
 └────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                  │ main-worker jobs / bounded results
 ┌────────────────────────────────────────────────▼────────────────────────────────────────────────┐
 │                       UTILITY PROCESSES / WORKER THREADS                                       │
 │  Hashing and bounded archive metadata in main workers; document parsing workers live beside renderer adapters │
 │  No renderer authority, credentials, generic filesystem API, subprocess spawning, or SQLite    │
 └────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                  │
                                                  │ Typed IPC (contextBridge)
                                                  │ Validated with Zod Schemas
                                                  │
 ┌────────────────────────────────────────────────▼────────────────────────────────────────────────┐
 │                                  PRELOAD BRIDGE (Sandboxed)                                     │
 │  - window.interleafAPI (Strictly whitelisted methods; no raw IPC or Node primitives)            │
 └────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                  │
                                                  │ Direct Method Calls & Subscriptions
                                                  │
 ┌────────────────────────────────────────────────▼────────────────────────────────────────────────┐
 │                                RENDERER PROCESS (Chromium Sandboxed)                            │
 │                                React 19 + TypeScript + Vite + Tailwind                          │
 │                                                                                                 │
 │  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
 │  │ Application Shell (Resizable Panels, Header Toolbar, 6 WCAG AA Palettes, Focus Mode)      │  │
 │  └─────────────┬───────────────────────────┬───────────────────────────┬─────────────────────┘  │
 │                │                           │                           │                        │
 │  ┌─────────────▼────────────┐┌─────────────▼────────────┐┌─────────────▼────────────┐          │
 │  │  Document Reader Engine  ││  Unified Annotation Bar  ││  AI Research & Citations │          │
 │  │  PDF / EPUB / MOBI / DOCX││  Kindle Sidebar / Notes  ││  Context Chips / Chat    │          │
 │  └──────────────────────────┘└──────────────────────────┘└──────────────────────────┘          │
 │                │                           │                           │                        │
 │  ┌─────────────▼────────────┐┌─────────────▼────────────┐┌─────────────▼────────────┐          │
 │  │  Agent Task Composer     ││  Library & Folder Browser││  Settings & Diagnostics  │          │
 │  │  Stream Monitor & Diff   ││  Recent / Progress       ││  AI / Agent Configuration│          │
 │  └──────────────────────────┘└──────────────────────────┘└──────────────────────────┘          │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The main-worker block is a side branch owned and scheduled by main, not an IPC
hop between main and preload. Renderer requests always travel directly through
the typed preload/main boundary. Reader parsing workers are renderer-owned,
receive only bounded in-memory jobs, and never gain main privileges.

---

## 2. Directory & Module Layout

```text
src/
├── main/                           # Electron Main Process (Privileged Node.js)
│   ├── index.ts                    # Main entry point & app lifecycle
│   ├── app/                        # Lifecycle services: shutdown barrier, active work,
│   │   └── settings-update.ts      #   settings:update rules (revalidation, unsafe confirm, runtime effects)
│   ├── windows/                    # BrowserWindow creation & management
│   ├── ipc/                        # IPC dispatchers & request routing
│   │   └── dispatcher.ts            # Validation wiring; routes each channel to its owning service
│   ├── db/                         # Database layer
│   │   ├── database.ts             # SQLite connection & WAL configuration
│   │   ├── migrations.ts            # Versioned schema migrations
│   │   └── repositories/           # Domain repositories (Document, Annotation, Chat, Agent, Search)
│   │       ├── search-repository.ts # FTS5 state and query ownership
│   │       └── search-preview-chunks.ts # The index's read-only preview query (library previews)
│   ├── library/                    # Library storage & file hashing
│   │   ├── storage-manager.ts      # Managed copy vs Link-in-place
│   │   └── metadata-extractor.ts   # Cover & metadata extraction
│   ├── workers/                    # Bounded main-owned worker coordinators
│   │   ├── hash-file-worker.ts     # Streaming document hashes
│   │   └── zip-metadata-worker.ts  # Bounded archive metadata inspection
│   ├── ai/                         # AI provider layer
│   │   ├── provider-registry.ts    # Provider registry and status
│   │   ├── providers/              # CLI, OpenRouter, and fake providers
│   │   ├── context-builder.ts      # Context selection and budgeting
│   │   └── provenance-serializer.ts # Machine-readable provenance formatting
│   ├── documents/                  # Main-owned document rendering services
│   │   └── mermaid/                # Diagram scheduling, bounds, and output guard
│   ├── agents/                     # Agent execution runtime
│   │   ├── agent-service.ts        # Session lifecycle and event persistence
│   │   ├── agent-adapter.ts        # CLI/fake adapter registry and argv
│   │   ├── environment-manager.ts # Worktree/copy/direct environment lifecycle
│   │   ├── environment-change-plan.ts # Pure manifest comparison and Apply refusal rules
│   │   └── process-runner.ts       # Bounded shell-free subprocess runner
│   └── security/                   # Hardening & verification
│       ├── protocol-handler.ts     # interleaf-media:// custom scheme
│       ├── path-guard.ts           # Path canonicalization & boundary checks
│       └── credential-vault.ts     # Electron safeStorage wrapper
│
├── preload/                        # Secure Preload Scripts
│   └── index.ts                    # contextBridge exposure and typed bridge
│
├── renderer/                       # UI Layer (React 19, TypeScript, Tailwind)
│   ├── index.html                  # HTML entry point with CSP
│   ├── main.tsx                    # React mount & provider tree
│   ├── mermaid-sandbox/            # Isolated, preload-free diagram renderer page
│   ├── app/                        # App shell, routing, layout
│   ├── components/                 # Shell compositions and shared accessible UI primitives (`ui/`)
│   ├── features/                   # Domain feature slices
│   │   ├── reader/                 # Reader viewport & format engine host
│   │   │   ├── adapters/           # PDF.js, pinned Foliate, direct OOXML drivers/workers
│   │   │   ├── components/         # Page virtualizer, floating toolbar, TOC
│   │   │   └── hooks/              # useDocument, useReaderNavigation
│   │   ├── annotations/            # Highlights, notes, Kindle-style browser
│   │   ├── chat/                   # AI chat panel, context chips, citations
│   │   ├── agent/                  # Agent task composer, stream, diff viewer
│   │   ├── settings/               # Settings dialog: providers, credentials UX, preferences, updates
│   │   ├── library/                # Book grid, folder tree, recent reads
│   │   └── search/                 # Indexed search UI and chunk normalization
│   ├── stores/                     # Zustand state stores
│   │   ├── use-reader-store.ts     # Active document, location, zoom, theme
│   │   ├── use-annotation-store.ts # Highlight & note cache
│   │   ├── use-chat-store.ts       # Active conversation & context items
│   │   ├── chat/                   # Slices and helpers owned by use-chat-store
│   │   ├── use-agent-store.ts      # Active runs, streaming output, diffs
│   │   ├── agent/                  # Context capture, run attempts and drafts owned by use-agent-store
│   │   ├── use-library-store.ts    # Documents and folders
│   │   ├── use-search-store.ts     # Search state
│   │   └── use-ui-store.ts         # Palette, panels, focus mode
│   └── styles/                     # Tailwind CSS & 6 palette theme tokens
│
└── shared/                         # Portable Types, Schemas & Constants (No Node.js imports)
    ├── types/                      # TypeScript definitions (Document, Annotation, AI, Agent)
    ├── schemas/                    # Zod runtime validation schemas
    ├── models/                     # Cross-process transport and caught-value models
    ├── constants/                  # IPC channel names, default prompts, limits, document-format registry
    └── errors/                     # Structured domain error hierarchy
```

### 2.1 Type and model ownership

`no-restricted-syntax` rejects the `any` and `unknown` keywords in every linted
TypeScript file, so every value a module hands on has to be described by a type
that says what it really is. Where that type lives follows the same ownership
rule as the code:

- **`src/shared/models/`** holds only contracts that genuinely cross a process,
  storage or provider boundary. A model here is structured-clone safe: plain
  data, no Node or Electron imports, no class instances, no behavior. Electron
  strips prototypes over IPC, so these are `type` aliases — usually derived from
  the owning Zod schema — rather than classes. Classes remain the right tool for
  process-local behavior and identity, never for a payload in transit.
  - `portable.ts` — `PortableValue` and its guards: the declared type of data
    that has crossed a boundary but has not been validated yet. It carries no
    authority; narrowing it to a domain model still requires a guard or a Zod
    schema. Its runtime counterpart is `schemas/portable.ts`.
  - `caught-error.ts` — `CaughtError` and the conversions that describe a
    thrown value, so the one genuinely open case in the language is handled at a
    single point rather than spreading through the codebase.
- **`src/shared/types/` and `src/shared/schemas/`** remain the single source of
  truth for domain and IPC contracts. Derive an input model from its schema
  (`z.input<typeof schema>`) instead of restating it; a field is optional only
  when its absence is a real current state, and actual variants are discriminated
  unions.
- **Process-local types stay with the feature that owns them** — a main-only
  repository row, a renderer store's shape, an adapter's internal state. They do
  not move to `shared/` merely to be reused by a test.

An untrusted boundary still validates at runtime. The rule changes only how the
not-yet-validated value is *typed* on the way in: as `PortableValue` or a
schema-derived input model, never as an unconstrained one.

---

## 3. Preload Bridge & Typed IPC API Contract

The source of truth is `src/shared/types/api.ts`; the preload implementation is
`src/preload/index.ts`. The exposed namespaces are deliberately narrow:

```text
app          getInfo, onBeforeClose, openExternal
settings     get, update
library      import/open/list/close/delete documents, folders, reading-position
             saves, summary, and onStorageHealthUpdated
annotations  create/list/page/update/delete/repairAnchor
search       begin/append/complete/fail index, getIndexState, search, resolveHit
ai           listProviders, getProviderStatus
onboarding   getLaunchState
credentials  set/clear/status/test OpenRouter key
chat         session/context/message CRUD, cancel, resolveCitation, onStreamEvent
agent        profiles, authoritative directory listing/selection,
             start/stop/session/review/apply/discard/export/open, risk grant,
             mode availability, onEvent
updates      getState, check, download, restart, openReleasePage, onState
             (payload-free; the feed and the release page URL are fixed in main)
```

Each call maps to a named channel in `src/shared/constants/ipc.ts`; main-side
schemas in `src/shared/schemas/` validate inputs and results. Push callbacks
receive validated domain events with the Electron event object stripped. No raw
`ipcRenderer`, generic invoke/send, Node primitive, filesystem path, or secret
credential is exposed to the renderer.

The main window always loads the preload, so the global is typed as required.
`src/renderer/app/api-client.ts` is the only renderer module that reads it: it
exports the `bridge` singleton every store and component imports.
`src/renderer/main.tsx` checks once at startup that the bridge is installed and,
without it, renders a single static fatal message instead of mounting the app.
Call sites therefore never guard for a missing bridge or a missing method, and
no module touches the bridge at import time.

`onboarding.getLaunchState` is payload-free and answers from two sources with
different lifetimes. The evidence that separates a new install from an existing
one — an empty migration history, an absent `settings` row, the absence of any
user-created row — is destroyed by `runMigrations` (migration 2 seeds the
`settings` row itself) and by the first `SettingsRepository.get()`. Main
therefore reads it in `src/main/app/onboarding-launch-state.ts` immediately
after `InterleafDatabase.open` and before any migration, derives one verdict,
and latches that install classification write-once for the process lifetime.
The reader's own progress is not part of that classification: a renderer reload
is a new page load, not a new launch, so each query reconciles the latched state
with the persisted `onboarding` section through
`reconcileOnboardingLaunchState`. A dismissal or completion recorded in this
process therefore governs the reload rather than being overruled by the startup
verdict, while `not-started` leaves the latched classification and its
first-launch and restart behaviour exactly as captured. The renderer never
classifies the launch itself.

`not-started` describes a narrower window than "nobody has acted on this
launch": it is what a fresh store is seeded with and what holds until the wizard
is first opened. Auto-opening is itself an opening — `openWizard` in
`src/renderer/stores/use-onboarding-store.ts` persists `in-progress` as it opens,
without waiting for the reader to do anything — so an untouched first launch is
`not-started` only up to the auto-open, and `in-progress` from that point on.
That is the intended behaviour, not a discrepancy: a reload after the auto-open
resumes the flow rather than auto-opening it a second time.

Every bridge input has a matching Zod schema in main. `DocumentLocation` is a
compile-time discriminated union and a runtime schema; credential responses are
always masked. Main clears transient request buffers as practical and neither
echoes nor logs secret inputs.

---

## 4. Document Reader Adapter Interface

All document engines implement a unified adapter contract in the renderer, decoupling document rendering from annotations, search, and AI context assembly:

```typescript
// src/renderer/features/reader/types.ts
import type {
  DocumentFormat,
  DocumentLocation,
  NormalizedTextChunk,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';

export type DocumentSource = {
  readonly documentId: string;
  readonly assetUrl: string;
  readonly initialLocation?: DocumentLocation | null;
};

export type DocumentAdapter = {
  readonly format: DocumentFormat;
  open(containerElement: HTMLElement, source: DocumentSource): Promise<void>;
  close(): Promise<void>;
  getTableOfContents(): Promise<readonly TableOfContentsItem[]>;
  render(location?: DocumentLocation): Promise<void>;
  goToLocation(location: DocumentLocation): Promise<void>;
  getReadingLocation(): { readonly location: DocumentLocation; readonly progress: number };
  getProgress(): number;
  search(query: string): Promise<readonly SearchMatch[]>;
  extractText(): AsyncIterable<NormalizedTextChunk>;
  extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]>;
  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void>;
  getZoom(): number;
  getZoomMode(): ZoomMode;
  getPageCount(): number;
  getCurrentPage(): number;
  goToPage(pageNumber: number): Promise<void>;
  // Reports a link the reader clicked; the adapter never opens it itself.
  setExternalLinkCallback?(callback?: ((url: string) => void | Promise<void>) | null): void;
};
```

An adapter neither navigates nor opens a window. A clicked link is reported to
the host that mounted the adapter, which validates the target and asks main
through `app:open-external`; main validates it again and hands it to the
default browser. In-document `#` anchors stay internal and any other scheme
stays inert.

`DocumentLocation`, `DocumentAnchor`, and adapter errors are validated discriminated unions. DOM rectangles are ephemeral render results only; persistence uses normalized format-specific anchors. Reader adapters never persist annotations.

---

## 5. Main Process Subsystems

### 1. SQLite Database Ownership
The main process exclusively manages database connections using synchronous WAL mode (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`). All reads and writes are encapsulated inside typed repository classes (`DocumentRepository`, `AnnotationRepository`, `ChatRepository`, `AgentRepository`). No SQL queries are transmitted across IPC.

### 2. Managed Library & Link-in-Place Storage
- **Managed Copy (Default)**: Ingested documents are copied to `<userData>/library/<sha256[0..1]>/<sha256>.ext`. Ensures immutability, prevents broken paths, and deduplicates identical binaries.
- **Link-in-Place (Optional)**: Retains original filesystem location, storing file path, modification timestamp, size, and SHA-256 hash for drift detection.

### 2a. Files Opened Without Importing (ADR 0014)
- **Delivery**: the File menu (*Open…*, *Import to Library…*), `fileAssociations`, macOS `open-file` (registered at module load and queued before `ready`), the launch argv and `second-instance` argv. `OpenFileRequestQueue` keeps the latest request; main pushes `files:command` and the renderer claims it through `files:openPending` or asks for `files:openDialog`. The renderer never supplies a path.
- **Isolation**: `OpenFileManager` holds at most one `OpenFileStore` — an `InterleafDatabase.open(':memory:')` with its own repository and service set plus a private staged copy under `<userData>/open-files`. Document- and session-scoped IPC is routed to the owning store (`open-file-routing.ts`); every other request uses the library's services.
- **Lifetime**: open, close and replace are serialized. Closing the reader, opening another file or a library document, closing the window and quitting dispose the store (cancel chat streams, revoke capabilities, close the database, delete staging); startup sweeps leftovers. Closed ids stay refused. Agent Mode is refused for opened files.

### 3. AI Provider Abstraction
Encapsulates local CLI execution and API access (OpenRouter) behind the provider
registry. Reader Chat supports Claude Code, OpenRouter, and a connected ChatGPT
subscription through an explicitly user-authorized constrained Codex path.
Codex is **not genuinely tool-free**: main resolves the canonical binary,
creates a private empty app-owned cwd, invokes the read-only sandbox with
`approval_policy="never"`, ignores user config/rules, supplies a minimal
allowlisted environment, bounds I/O and wall-clock time, supports cancellation,
and aborts unsupported tool/events fail closed. This is residual-risk
containment, not removal of Codex's tool surface. Pi is also selectable for
Reader Chat whenever main's own probe reports a signed-in Pi model provider,
and its invocation is genuinely tool-free: the same transport launches
`pi --mode json --print --no-tools` with Pi's discovery, session, approval and
online-startup surfaces disabled, exposes only models Pi's own listing
published, and treats any tool event as a fail-closed violation. Omp (Pi's
successor) is a Reader Chat provider on the same transport with the equivalent
hardened flag set and the same fail-closed parsing, minus any offline claim —
Omp has no such flag, so the guarantee is tool-free chat only. A `local`
provider connects to an inference server on this machine over **literal
loopback HTTP only** (`127.0.0.1`/`[::1]`, no names, no path or query), using a
`node:http` transport that honours no proxy, follows no redirect and performs
no name lookup; main owns the endpoint validation, the network calls and the
persistence, and the renderer reaches it only through existing typed IPC. That
names the socket, not the silicon: Ollama may still route a cloud-capable model
upstream, which Interleaf discloses rather than papers over. Antigravity
remains an Agent Mode integration. Context chunks are serialized into machine-readable citation
blocks with request-local IDs such as `<source id="src-1" page="42">...</source>`
and streamed responses are normalized through the chat service. No live paid
ChatGPT reply or D21 normal/200% screenshot is part of the validated evidence.

### 4. Agent Runtime & Sandboxing
- **Isolated Worktree (Default for Git)**: Runs `git worktree add` in `<userData>/agent-workspaces/<sessionId>` to isolate file modifications. Computes unified diffs and allows safe patch application.
- **Isolated Directory Copy (Default for non-Git)**: Copies project files to a temporary workspace and computes delta diffs.
- **Active Environment**: Direct execution in the project directory, gated by deliberate user confirmation and visual risk alerts.
- **Process Safety**: Normal execution invokes `child_process.spawn` with `shell: false` and tokenized argument arrays.

### 5. Utility-Process and Worker Boundary
Implemented main-owned workers are `hash-file-worker.ts` and
`zip-metadata-worker.ts`; they receive bounded jobs and return typed results.
The PDF, EPUB/MOBI, and DOCX parsing workers are implemented beside their
renderer reader adapters (`src/renderer/features/reader/adapters/`). Main-owned
repositories remain the only SQLite writers. A separate general-purpose main
extraction/diff worker coordinator is future architecture, not a current module.

A worker is the preferred shape for bounded parsing work and is used wherever it
fits. The isolated diagram renderer below is the documented exception: the pinned
Mermaid build needs a real DOM for text measurement, so its job runs in a
separate renderer process rather than a worker thread. That choice also buys real
cancellation, which a worker would not: a runaway render is ended by destroying
its process, not by resolving a race.

### 6. Bounded Web-Article Ingestion Subsystem
Captures public web articles for offline reading through the existing Markdown adapter without external service dependencies (ADR 0012):
- **Bounded Outbound Fetcher (`WebArticleFetcher`)**: Enforces public-only address policy on initial URLs and all redirects. Pins validated DNS answers directly to the socket to prevent DNS rebinding. Bounded by standard ports (80/443), redirect count (max 5), transfer size (5 MB), decompressed size (12 MB and 50x the wire size), content type (`text/html`, `application/xhtml+xml`), and wall-clock time (20s). Sends no cookies, auth, or referrers.
- **Isolated Worker Extraction (`article-extract-worker.ts`)**: Untrusted HTML is parsed off the main thread in short-lived worker threads using non-executing `linkedom`. Active content, styles, scripts, embeds, forms, and tracking beacons are stripped. Returns a schema-validated inert block/inline Intermediate Representation (IR). The IR carries semantic tables (row/column order, `<thead>` or inferred strong-emphasis header row, cell text and `http(s)` links) and image *candidates* — resolved URL, alt text, caption, role — never image bytes. Bounds: 60 tables, 200 rows, 24 columns, 2,000 cells, 40 inlines per cell, 40 image candidates. A cell that exceeds the per-cell inline bound costs its table the pipe-table shape, not the article: the table degrades to the ordered-paragraph fallback. After the walk, a bounded reconciliation pass restores editorial figures the readability scoring dropped — linked, lazy, `srcset`-only, and hero figures — by comparing the sanitized DOM inventory captured before scoring against the surviving blocks, placing each at its document position. The inventory records which occurrence of a neighbouring line each figure sat next to — an ordinal bounded by the block ceiling, worker-internal, never persisted or exposed — so a figure that followed the third of four identical paragraphs is restored after that occurrence rather than an earlier one. Extraction registers every eligible image it recognizes, in the inventory and in the IR walk alike, up to a ceiling derived from the block ceiling, and stops recognizing beyond it; each recognized candidate is then either emitted or counted in the omission total, so the two partition recognition exactly. Restored candidates obey every ordinary candidate rule plus a furniture-ancestor rejection (comment threads, share widgets, related/sponsored strips, bio cards, sidebars, `nav`/`aside`/`footer`/`form` and their landmark roles), and nothing is restored to reach a count.
- **Bounded Media Transport (`web-media-fetcher.ts`, `web-media-transport.ts`, `raster-decode-worker.ts`, `raster-container.ts`)**: A separate main-owned fetch path for image bytes reusing the same address policy, DNS pinning, per-hop redirect re-validation, and anonymous request shape. Accepts only the five approved still rasters — static PNG, JPEG, WebP, GIF, and AVIF (ADR 0013). An isolated worker first classifies the container by bounded structural walk (exact PNG, structurally plausible JPEG, GIF87a/89a, exact RIFF/WEBP, ISOBMFF `ftyp` with AVIF still branding only), refuses animation and sequence signalling by structure (real PNG `acTL` chunks, WebP `VP8X` animation bits plus `ANIM`/`ANMF` even around one frame, looping or multi-frame GIFs, AVIF `avis` branding or `moov` boxes; the decoder page count stays as defence in depth), and requires the first complete container to end exactly at the last byte, so mislabeled SVG/HTML/TIFF/PDF, appended payloads, and fake trailing sentinels never reach the decoder. The pinned `sharp` (0.35.4) then fully decodes the still inside the worker, and its pixels are re-encoded to deterministic safe canonical PNG bytes bounded by the caller's per-file allowance. SVG and any active or vector markup remain rejected outright. Bounded by redirects (3), per-file input bytes (8 MB), dimensions (32–20,000 px per side, 40,000,000 px total), a decompressed-output cap, time (15s per request), queue capacity (8), and worker concurrency (2, each admission slot held until its worker terminates and exits). Cancellation and deadlines propagate promptly to active and queued work.
- **Media Collection (`article-media.ts`, `article-media-phase.ts`, `media-phase-clock.ts`)**: Runs after extraction against the same image list the renderer will display. Bounded by archived count (40, derived from the IR's image bound so the two limits cannot drift), aggregate bytes (24 MB), concurrency (3), and a 30s phase allowance beyond the page deadline. The aggregate is divided into per-image reservations, charging stored canonical bytes as well as wire bytes so re-encoding inflation is accounted for, and a lane refunds only the part of its reservation that was neither moved on the wire nor stored. Admitted bytes are deduplicated by content hash. One image failing is omitted with its alt text and caption intact; so is every remaining candidate when the phase deadline passes, which stops work in flight and returns the article partially illustrated rather than failing the import. The phase owns its own abort signal so that clock never reaches the page fetch or its address checks; explicit cancellation, the page deadline, and admission or security failures remain fatal. Archived and omitted counts partition the candidate list exactly (`archived + omitted === candidates`), counting candidate references rather than stored files; omitted covers candidates the extraction ceiling dropped before the phase began — a count bounded by the same ceiling that bounds how many candidates extraction recognizes at all, never a saturated approximation — ones the count cap removed before any request, ones the exhausted byte budget skipped, ones that failed, and ones left unfetched at the deadline. `requested` means a transport call actually started and overlaps both halves rather than partitioning anything. With no image transport the phase reports every candidate as omitted and makes no request.
- **Inert Markdown Generation (`article-markdown.ts`)**: Pure transformation from IR to Markdown. Escapes structural characters, fences code blocks safely, and flattens metadata into single-line front matter. Retains article headings, lists, quotes, code, captions, and validated `http`/`https` links. Supported tables become GFM pipe tables with `|`, `\`, and newlines escaped inside cells; unsupported ones (rowspan/colspan or over budget) degrade to ordered paragraphs. Archived images become `interleaf-asset:<sha256><ext>` references — the snapshot never contains a remote or capability URL.
- **Content-Addressed Storage & Deduplication**: Managed snapshots and archived images are staged under `.tmp` and placed atomically at `<userData>/library/<hash[0..2]>/<hash>.<ext>`. Re-importing identical bytes deduplicates to the existing document row; re-importing the same normalized source URL upgrades that capture in place, replacing snapshot and assets in one transaction and deleting superseded files only afterwards and only when orphaned.
- **Opaque Media Capabilities**: On open, main mints document- and scope-bound `interleaf-media:` URLs with a 15-minute default lifetime (60-minute ceiling); the renderer's Markdown adapter substitutes them for `interleaf-asset:` references at render time. Closing, deleting, or upgrading revokes them. No filesystem path crosses IPC (ADR 0011).
- **Additive Provenance**: Persists `source_kind`, `source_url`, `source_site_name`, and `source_captured_at` in SQLite (Migration 21) while leaving user-imported document provenance as `NULL`. Migration 22 adds `document_assets` relating a document to its archived images.

### 7. Isolated Diagram Renderer (fenced `mermaid`)
Draws fenced `mermaid` blocks in Markdown documents as still pictures, offline,
from the locally bundled official library:
- **Reader side (`mermaid-block.ts`, `markdown-adapter.ts`)**: A fenced diagram
  renders as the ordinary `<pre>` code block wrapped in a `<figure>`. The
  `data-markdown-block` attribute moves to the figure and is not repeated, so the
  document still has exactly one block element per index and the unchanged
  `.markdown-block-content` span keeps block indexes, character offsets, text
  extraction, search, citations, and stored annotation anchors meaning what they
  meant before a picture existed. The drawing is displayed as an `<img>` and the
  source always stays visible. The diagram box is capped to a fraction of the
  reader viewport and scrolls locally; while — and only while — it overflows it
  becomes a focusable, named `region`, mirroring the wide-table affordance.
  Appearance is derived from the painted background luminance and re-derived on
  `data-theme`/`data-reader-background` changes, so an independently overridden
  reader background is honoured.
- **Transport**: One contract-driven channel, `reader:render-mermaid`, request and
  result both schema-validated at the main boundary and again at the preload
  bridge. Failures are typed values, never exceptions: an undrawn diagram costs
  one illustration and one explanatory line, never the document.
- **Main scheduling (`mermaid-render-service.ts`)**: Owns the source policy, the
  queue, the per-job identity, the wall-clock deadline enforced by process
  termination, and the re-validation of everything the isolated process claims.
- **Isolated renderer (`mermaid-sandbox-window.ts`, `src/renderer/mermaid-sandbox/`)**:
  A hidden, preload-free, network-denied window that accepts one JSON job and
  answers with one JSON result, rebuilding its output from an allow-list before
  returning it. Configuration, theme, fonts, and bounds are fixed in code; no
  document, renderer, or job contributes a path, a URL, or a colour.

See [Security](SECURITY.md) for the full threat treatment and residual limits.

### 8. Linux/Wayland runtime switches
`src/main/app/linux-platform.ts` decides the Chromium command-line switches a
Linux run needs, as pure data: it imports nothing from Electron and takes the
platform, an environment snapshot, and the `enable-features` value already on
the command line. `src/main/index.ts` applies them at module load, before
`app.whenReady()`, because Chromium reads them once during initialization.
Non-Linux platforms get an empty list, so darwin and win32 startup is unchanged.

| Switch | Why |
|---|---|
| `ozone-platform-hint=auto` | Native Wayland on a Wayland session (Hyprland/Omarchy), X11 otherwise. Suppressed when `ELECTRON_OZONE_PLATFORM_HINT` is already set, which is a deliberate user override. |
| `enable-features=WaylandWindowDecorations` | Client-side decorations on compositors that draw no frame. Merged with any existing value rather than replacing it. |
| `enable-wayland-ime` | Routes input-method text (fcitx5/ibus) into Chromium. |
| `class=Interleaf` | Pins the X11 `WM_CLASS` (XWayland fallback). The Wayland `app_id` comes from Electron's desktop name, pinned by package.json `desktopName` (`Interleaf.desktop`), which is also the installed desktop-entry file name (`linux.executableName: Interleaf`); the desktop entry's `StartupWMClass` must equal both. |

### 9. Application updates
`src/main/updates/` owns stable-channel updates for the two install shapes that
can replace themselves: a packaged macOS app (Squirrel.Mac through
electron-updater's `MacUpdater`) and an x64 AppImage (`AppImageUpdater`).
`install-type.ts` decides the shape from facts main reads itself. Development
runs, Windows, deb/pacman installs (electron-builder's `resources/package-type`
marker), DMG-mounted or translocated copies and anything else never construct
an updater and never contact the network.

- `update-trust.ts` pins the destination (`https://github.com/FrescoFlacko/interleaf-releases`),
  the product id and the Ed25519 signing keys at build time. Production builds
  from 0.5.0 pin the bootstrapped release key. With no key pinned (a malformed
  smoke anchor, for instance) the service reports `not-configured` and makes no
  request. Development is decided by `runtime-packaging.ts`, the same rule the
  brand startup uses: a renamed development bundle reports `isPackaged` but
  keeps `process.defaultApp`, and still never constructs an updater.
- `signed-release-provider.ts` is electron-updater's only provider. It fetches
  `releases/latest/download/interleaf-stable-{mac,linux-x64}.json` and verifies
  it with `update-manifest.ts` (signature, product, channel, platform, arch,
  strictly newer version). It then gives electron-updater one file built only
  from that verified statement, at the verified tag on the same origin.
  electron-updater still checks the SHA-512 of full, cached and differential
  downloads.
- `update-service.ts` is the state machine behind the payload-free `updates:*`
  channels. Automatic checks (60 s after launch, then every 12 h) follow
  `updates.automaticChecks`. Download and restart happen only on explicit calls.
  Restart refuses while work is live, as counted by the services that own it
  (`src/main/app/active-work.ts`): Reader Chat replies, preparations and
  compactions in the library and in an opened file; imports and pending opens
  (`src/main/app/work-admission.ts`); accepted agent operations and runs whose
  process is not yet reaped. The final idle reading, the shutdown-barrier
  reservation and closing every service's admission happen in one synchronous
  step before the renderer is asked to flush, so nothing new starts during the
  handshake while flush writes such as reading positions and unsaved note
  text still land. The
  install then runs after the same drain as an ordinary quit
  (`src/main/app/shutdown-barrier.ts`).
- `smoke-trust.ts` lets only a build made with `INTERLEAF_UPDATE_SMOKE_TRUST`
  trust a loopback origin and a single throwaway key, for
  `electron.update-smoke.ts`. Any other value pins no key.

Release tooling (`electron.update-release.ts`) signs, stages a draft, verifies
it and promotes it; see [Packaging ▸ Stable updates](PACKAGING.md#stable-updates).
No database schema change is involved.

---

## 6. Architecture Change and Residual-Risk Governance

Architectural invariants define the safety and responsibility boundaries of the product. They are constraints on implementation, not instructions to expand every feature into an exhaustive hardening project. When a requested capability conflicts with an invariant, the conflict becomes a product/architecture decision and MUST be surfaced before implementation continues.

### 6.1 Architecture-Conflict Gate

An implementation is blocked for a decision when the underlying platform, provider, CLI, or dependency cannot enforce a required invariant. The responsible agent must document:

1. the requested capability;
2. the invariant it cannot satisfy;
3. evidence that the required enforcement mechanism is unavailable;
4. viable alternatives and their product/security tradeoffs; and
5. the recommended option.

The agent must then pause mutation work and obtain an explicit user/product decision. Repeatedly adding compensating controls is not a substitute for that decision when the underlying guarantee remains impossible.

The Codex-backed ChatGPT provider illustrates this distinction: a private empty working directory, read-only sandbox, minimal environment, bounded I/O, and fail-closed event classification reduce risk, but they do not make Codex genuinely tool-free. The constrained integration is therefore an explicitly authorized residual-risk design, not proof that the original tool-free guarantee was achieved.

### 6.2 Residual-Risk Decisions

An approved exception must be captured in an ADR or the relevant architecture/security specification. The record must state:

- which invariant or desired guarantee cannot be fully met;
- which controls are mandatory for the constrained implementation;
- what those controls guarantee and what they only mitigate;
- the remaining failure and abuse cases;
- the user/product decision authorizing the tradeoff; and
- the conditions that would trigger reconsideration, such as a provider adding an enforceable tool-disable mode.

Documentation and UI copy must describe residual risk truthfully. Terms such as “tool-free,” “isolated,” “safe,” or “disabled” may be used only when the corresponding property is technically enforced, not merely inferred from prompts or filtered after execution.

### 6.3 Change-Scope and Review Boundaries

Architecture and security review findings are attributed as `introduced-by-change`, `pre-existing`, `adjacent`, or `speculative-hardening`.

- P0/P1 issues introduced by the change block completion.
- The minimum boundary controls needed to ship the requested behavior safely are part of the change.
- Pre-existing or adjacent P0/P1 issues require a separate scope decision unless they pose an immediate active safety risk.
- P2/P3 and defense-in-depth opportunities are recorded as backlog by default.
- One implementation review and one correction review are the normal limit; further cycles require an unresolved introduced P0/P1 or explicit authorization.

Verification must be proportional to the claim being made: focused boundary tests for internal/process changes, visual evidence for visual defects, and full E2E or packaging checks for milestones and releases. Discovering a new gap does not automatically authorize fixing it in the current work unit.

### 6.4 Goal-Mode Decision Protocol

Goal mode preserves an objective across turns but remains user-directed and conversational. The user may ask follow-up questions, request status, challenge assumptions, redirect priorities, pause work, or make a required architecture decision at any time. Agents answer those questions without treating them as an automatic replacement of the goal.

If a follow-up materially changes scope, the agent identifies the new boundary and records or confirms the revised work unit. If an architecture decision or broader authority is required, mutation work pauses while discussion and read-only research remain available. A persistent goal never overrides an explicit request to stop, pause, narrow, or return control.

---

## 7. Renderer State Architecture (Zustand)

```
┌────────────────────────────────────────────────────────────────────────┐
│                          ZUSTAND STATE STORES                          │
├───────────────────┬───────────────────┬────────────────────────────────┤
│ useReaderStore    │ useAnnotationStore│ useChatStore                   │
│ - activeDocument  │ - annotationsMap  │ - activeSession                │
│ - currentLocation │ - activeHighlight │ - messages[]                   │
│ - currentProgress │ - filterType      │ - contextChips[]               │
│ - activeZoom      │ - searchQuery     │ - isStreaming                  │
│ - isFocusMode     │ - selectedColor   │ - activeCitationNav            │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ useAgentStore     │ useLibraryStore   │ useSearchStore                 │
│ - activeSession   │ - documents[]     │ - activePalette ('paper', etc.)│
│ - streamingLogs[] │ - folders[]       │ - fontSize, fontFamily         │
│ - changedFiles[]  │ - activeFolderId  │ - configuredProviders          │
│ - activeDiff      │ - sortOrder       │ - query/results                 │
├───────────────────┴──────────────────┼────────────────────────────────┤
│ useUiStore                            │ palette, panels, focus mode      │
└───────────────────┴───────────────────┴────────────────────────────────┘
```

All stores update asynchronously in response to typed IPC events pushed from the main process, ensuring the UI is never frozen by background file operations or AI streaming.

Async ordering is owned by the module that owns the race. Latest-wins
generation counters (hydration, profile refresh, session focus, loading turns)
are private, non-reactive module state of the store that issues the requests,
so bumping one never re-renders anything. The one counter another module needs
— the Agent context revision — is owned by `stores/agent/context-attach.ts` and
never handed out: other code takes a claim on it or declares an explicit choice
with `supersedeAgentContext()`. A store's dialog state that admits only one
open dialog is a single discriminated slot (`useLibraryStore.libraryModal`), not
a flag per dialog.
