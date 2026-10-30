# Interleaf — Security Architecture

Interleaf treats imported documents, renderer state, model output, CLI output,
and all IPC payloads as untrusted data. The controls below describe the current
implementation; a workspace-isolated agent is not automatically a security
sandbox.

## Electron boundary

`src/main/windows/main-window.ts` creates the window with the required profile:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
experimentalFeatures: false
```

`src/main/security/csp.ts` installs this response-header policy (the renderer
HTML also carries its own policy):

```http
default-src 'self';
script-src 'self';
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' interleaf-media: data: blob:;
media-src 'none';
font-src 'self' data:;
connect-src 'self' interleaf-media:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

The main window allows only the configured Vite origin during development and
blocks all other navigation in production. It denies every `window.open`
request and every `<webview>` attachment.

A link inside an open document is followed in the operating system's default
browser and never in the application. The renderer reports one target through
`app:open-external`; it does not navigate, open a window, or hold
`shell.openExternal`. Main re-derives the target with
`parseExternalHttpUrl` in `src/shared/schemas/external-link.ts` — absolute,
`http:` or `https:`, with a host, no embedded credentials, no whitespace or
control characters, and at most 2048 characters — and only then calls
`shell.openExternal`. Any other scheme, a relative path or an in-document `#`
anchor is not an external link and is never handed to the desktop.

Settings › Privacy carries an optional confirmation before an external link is
opened (`privacy.confirmExternalLinks`, default off, which preserves the
existing one-click behaviour). The preference is read in main at each request,
after the target has been re-derived, so the native dialog names exactly the
link that would be handed to the desktop. Declining reports "not opened" and
nothing leaves the process. If the preference is on and no confirmation
capability is wired, the request fails closed rather than opening the link
unconfirmed. The renderer cannot suppress or answer the dialog.

Log lines record only a generic outcome or error class — including a declined
confirmation. Nothing derived from the target is recorded — not the URL, not
the scheme, not the host — because a path, a query, or a hostname itself can
carry a token or identify the reader's own search terms.

Renderer permissions and device permissions are denied by default in
`src/main/security/permissions.ts`.

## IPC and preload

The only renderer bridge is `window.interleafAPI` from `src/preload/index.ts`.
Channels are named in `src/shared/constants/ipc.ts`, request schemas are wired
through `src/shared/schemas/ipc.ts`, and main-side dispatch validates every
payload before calling a domain service. The bridge does not expose raw
`ipcRenderer`, `fs`, `child_process`, generic `exec`, or `executeSql` methods.
Push events are structurally narrowed in preload and do not expose Electron IPC
event objects. Main validates sender ownership/origin where the operation is
sender-scoped.

The important domains are library, annotations, search, chat/credentials,
agent sessions, and agent environment review. These are high-level operations;
the renderer cannot choose a SQL statement, canonical path, executable path,
credential record, or recovery path.

## Web article import and SSRF controls

Web article import allows users to archive public web articles for offline reading without external hosted services (e.g. Firecrawl) or third-party accounts (ADR 0012). Because outbound network requests to user- or web-provided URLs introduce critical SSRF and remote execution risks, the pipeline enforces strict controls owned entirely by the main process:

1. **Address Policy (`src/main/net/address-policy.ts`)**:
   - Only standard schemes (`http:`, `https:`) on default ports (80, 443) are accepted; all nonstandard ports and other schemes (`file:`, `ftp:`, `data:`, `javascript:`, `ws:`) are rejected immediately.
   - Embedded credentials (`username:password@`) are forbidden.
   - Hostnames require at least two labels; single-label hosts and internal names (`localhost`, `intranet`, `metadata`) are rejected.
   - Rejects loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), multicast, documentation, and IPv4-mapped/derived IPv6 addresses.

2. **DNS Pinning & Rebinding Defense (`src/main/net/web-article-fetcher.ts`)**:
   - Main resolves hostnames once per hop. All returned addresses must be public; if any address is private or reserved, the connection is refused.
   - The validated public IP address is pinned directly to the HTTP/HTTPS request options via a custom `lookup` callback, ensuring the socket connects only to the verified IP and eliminating time-of-check to time-of-use (TOCTOU) DNS rebinding attacks. TLS certificate validation still matches against the SNI hostname.
   - Every redirect hop re-runs the complete address and DNS validation against the new target (capped at 5 hops).

3. **Fetch Resource Limits & Hygiene**:
   - Wire transfer is capped at 5 MB; the decompressed response is bounded at 12 MB and additionally at 50x its own wire size (with a 64 KiB floor so small pages still decode), so a few kilobytes cannot expand into megabytes.
   - The transport uses `node:http`/`node:https` over a dedicated agent, so no `HTTP_PROXY`-style environment variable can route a validated request through an unvalidated hop.
   - Only `text/html` and `application/xhtml+xml` content types are permitted.
   - Requests are completely anonymous and stateless: no application cookies, credentials, authorization headers, or referrers are sent, and response cookies are ignored.
   - Socket idle timeout is 10s; overall wall-clock deadline is 20s.

4. **Isolated Worker Extraction (`src/main/workers/article-extract-worker.ts`)**:
   - Hostile HTML is never parsed on the main thread or renderer. A dedicated worker parses markup using non-executing `linkedom` without script runtime, network access, or timers.
   - Execution is bounded by element count (max 60,000) and a parent-side termination timeout (15s).
   - Active and remote elements (`script`, `style`, `noscript`, `iframe`, `frame`, `object`, `embed`, `form`, `input`, `button`, `svg`, `math`, `canvas`, `audio`, `video`) and page chrome (`nav`, `header`, `footer`, `aside`) are completely removed before extraction.
   - `img` and `picture` are read for candidate metadata only — resolved URL, alt text, caption, role — and are then removed like any other remote element. The worker performs no network access of any kind, so nothing it reads can cause a fetch; the candidate URL is a string the main process may later choose to validate and request.
   - Candidate URLs come from `src`, a bounded `srcset` (24 entries, 8 KiB), and common lazy-loading attributes, resolved against the final response URL or against a `<base href>` captured before the purge when the document declares a safe one. Only `http`/`https` rasters survive; `data:`, `javascript:`, `file:`, and SVG candidates are dropped, as are chrome, icons, tracking pixels, and decorative or empty images.
     An absent `alt` may also qualify in a centered, text-free paragraph containing only one or two direct `img` children, inside the nominated article/main when one exists and outside unrelated regions. Explicit empty `alt` does not qualify through this heuristic. Captions remain prose, including long unclassed explanations; they are not borrowed or duplicated. Declared percentage dimensions are not pixel-size evidence.
   - Worker output is validated against a strict Zod schema (`extractedArticleSchema`) producing an inert intermediate representation, including tables bounded at 60 per article, 200 rows, 24 columns, 2,000 cells, and 40 inlines per cell, and image candidates bounded at 40 per article with 500-character alt text and 2,048-character URLs.
   - A bounded reconciliation pass then restores editorial figures the readability scoring dropped, comparing the sanitized DOM inventory taken before scoring against the blocks that survived. Restored candidates go through the same normalization, `http(s)` raster filter, URL resolution, IR bounds, and inert image block as any other candidate, and are additionally rejected when an ancestor within 12 levels is a comment thread, share widget, related or sponsored strip, author-bio card, sidebar, newsletter or consent surface, or a `nav`/`aside`/`footer`/`form` element or landmark role. The pass restores nothing to reach a count, and never restores active, vector, or interactive content, which was already removed before the inventory was taken.

5. **Bounded Media Retrieval (`src/main/net/web-media-fetcher.ts`, `src/main/library/article-media.ts`)**:
   - Image bytes are fetched only by main, only from candidate URLs that pass the *same* address policy, DNS pinning, and per-hop redirect re-validation as the article fetch, over the shared pinned client with its own agents and no proxy environment. Requests carry no cookies, credentials, authorization, or referrer.
   - Only the still rasters the pinned decoder can completely decode and validate offline in an isolated worker thread are admitted: static PNG, JPEG, WebP, GIF, and AVIF (ADR 0013). A declared content type agreeing with the bytes is necessary but not sufficient — a header describes an image, it does not prove one exists. Before any decode, an isolated worker (`raster-container.ts`, assembled into `raster-decode-worker.ts`) classifies the container by bounded structural walk — exact PNG, structurally plausible JPEG, GIF87a/89a, exact RIFF/WEBP, and ISOBMFF `ftyp` with AVIF still branding only — so mislabeled SVG, HTML, TIFF, or PDF bytes never reach the decoder. The accepted still is then fully decoded by the pinned `sharp` (0.35.4) inside that worker under bounded input (8 MB), decompressed-output, dimension (32–20,000 px per side, 40,000,000 px), and per-request time limits, and the decoded pixels are re-encoded into deterministic, safe canonical PNG bytes bounded strictly by the caller's per-file admission allowance before archiving.
   - Animation and multi-frame content are refused by structure before decoding: real PNG `acTL` chunks, WebP `VP8X` animation bits plus `ANIM`/`ANMF` chunks (even around one frame), looping or multi-frame GIFs (`NETSCAPE2.0` loop extensions, more than one image block), and AVIF `avis` branding or `moov` sequences; the decoder-reported page count (`pages > 1`) stays behind this as defence in depth. Every container must also end honestly — the walk requires the first complete container to consume the bytes exactly (PNG through IEND, GIF through its trailer, JPEG through the first true EOI, RIFF/ISOBMFF boxes to EOF, with extended-size boxes advanced by their declared 64-bit size) — so image+junk+fake-final-sentinel payloads and appended second pictures are refused. SVG and any active or vector markup are rejected rather than sanitized. The request `Accept` header offers only the five approved image types.
   - Per-response bounds: 3 redirects, 8 MB wire bytes, decoded dimensions between 32 and 20,000 px per side and at most 40,000,000 px, 15s per request. Decode admission itself is bounded by at most 2 concurrent isolated decoder workers with a queue of 8; a request's admission slot is released only after its worker has terminated and exited, and cancellation and deadlines propagate to every in-flight request and queued decode work. Per-article bounds: 40 archived images — the same constant the extraction IR is validated against, so the two cannot drift — 24 MB aggregate, 3 concurrent fetches, and a 30s phase deadline beyond the page deadline. The count is a shape bound; the byte, concurrency, and time bounds are what limit cost, and they are unchanged.
   - The aggregate is a spend, not a claim: each fetch is issued a share of the remaining article allowance and the transport enforces it *while the body streams*, aborting the response the moment a chunk would exceed it. A failed or invalid request is charged the bytes it actually moved, and a transport that reports nothing forfeits its whole reservation, so repeated 8 MB failures cannot move more than the aggregate the article was allowed. Stored canonical bytes are charged as well as wire bytes, ensuring re-encoding inflation cannot bypass the aggregate limit. Each request's deadline is the earlier of the collection deadline and the per-image timeout.
   - A single image that fails validation is omitted, keeping its alt text and caption, so one hostile or broken picture cannot cost the reader an otherwise complete article. A media-phase deadline is the same kind of event: it aborts the phase's own requests, counts every remaining candidate as omitted, and returns the article. The media phase holds a signal separate from the page fetch's, so a slow image host can neither cancel nor weaken the page fetch, its redirect re-validation, or its address checks. Explicit user cancellation, the page deadline, and admission or address-policy failures remain fatal for the whole import.
   - An incomplete capture is reported to the renderer as two bounded integers — how many images were archived and how many were not — and nothing else. The bounds are the real ones: archived cannot exceed the 40-image archive bound, and the two counts partition the image candidates extraction recognized, so neither can exceed that recognition bound and an out-of-range summary is refused rather than shown. The extraction worker contributes only a count of the editorial images its ceilings dropped, deduplicated by URL inside the worker and bounded there by the same ceiling that bounds how many candidates it recognizes at all; the URLs themselves never leave it. The bridge re-validates them with a strict schema and forwards no other field, so a URL, host, path, or failure reason cannot reach untrusted UI inside this value; an unusable summary is dropped and the completed import survives. Every reason available on the main side (a refused address, a host that did not answer, a payload the decoder rejected) is a description of Interleaf's own network and security behavior, which is why only the count crosses.
   - The renderer never fetches media. It receives typed metadata and opaque capabilities; a captured article reopened with networking disabled paints its images and makes zero outbound requests.

6. **Inert Markdown Storage & Additive Provenance**:
   - Extracted text is rendered to sanitized Markdown (`article-markdown.ts`), escaping formatting syntax and restricting links to `http:` and `https:`. Table cells additionally escape `|`, `\`, and newlines so a cell cannot forge a column boundary.
   - Archived images are referenced only as durable `interleaf-asset:<sha256><ext>` identities. A canonical snapshot never contains a remote URL or an ephemeral `interleaf-media:` capability; capabilities are minted at open time and revoked on close, delete, or upgrade.
   - Saved snapshots and archived images are staged in `.tmp` before atomic placement in content-addressed storage (`<userData>/library/<hash[0..2]>/<hash>.<ext>`). Identical articles deduplicate idempotently, and identical image bytes are stored once.
   - Re-importing the same normalized source URL replaces the snapshot and asset rows in one transaction, then deletes superseded managed files only when no surviving row refers to them.
   - Provenance is persisted in additive columns (`source_kind`, `source_url`, `source_site_name`, `source_captured_at`) via Migration 21, leaving user-imported document rows as `NULL`. Migration 22 adds `document_assets` relating a document to its archived images.

## Filesystem and media protocol

`interleaf-media://` serves only opaque, short-lived asset IDs from
`src/main/security/asset-registry.ts` and `protocol-handler.ts`. Registration:

- canonicalizes both root and leaf with `realpath`;
- requires a regular file under an app-managed media root;
- validates extension-derived MIME type and a bounded TTL;
- binds the ID to the active document and renderer scope.

Requests accept only `GET`/`HEAD`, a single bounded byte range, and a strict
asset-ID URL shape. The handler rechecks canonical containment, rejects the
final symlink, opens with `O_NOFOLLOW` on POSIX, compares opened identity with
the resolved path, and streams from the opened handle. It never uses a
whole-file `readFile` for media. Switching documents or closing a scope revokes
prior capabilities. Link-in-place documents are staged into app-managed
storage before reader assets are registered.

Working directories and executable selections use main-owned opaque handles.
Main canonicalizes and records the file identity described below, revalidates
it immediately before use, and rejects stale or changed handles. Prefix checks are
not used for containment. `src/main/security/path-guard.ts` is the canonical
owner of containment and the only main/preload module allowed to call
`path.relative`: `canonicalizeWithinRoots` realpaths root and candidate, and the
lexical helpers (`relativePathWithin`, `isPathWithin`, `isStrictlyInside`)
reject `..` traversal and other-root or other-drive results for callers that
pass canonical paths or check symlink ancestors themselves. Same-user processes can still race ordinary filesystem checks on
platforms without an open-beneath primitive; this is a documented residual
risk, not a claim of kernel containment.

### File and directory identity

Every main-owned "is this still the same file or directory" check uses one
definition, owned by `src/main/security/file-identity.ts`: the device, the
inode, and the birth time in nanoseconds, read with a bigint `stat`. This
covers working-directory capabilities, persisted session target identities,
environment journals, risk-confirmation grants, custom-profile executable
identities, and recovery backups. Device and inode alone are not an identity:
Linux filesystems such as ext4 reuse inode numbers, so a directory deleted and
recreated at the same path can come back with the same pair. Birth time is set
when the inode is allocated and is unaffected by writes, renames, or new
entries, so a reused inode carries a new birth time. `ctime` is not used,
because adding an entry to a directory changes it.

When a filesystem reports no birth time (zero, for example on some NFS or FUSE
mounts or kernels without `statx`), the identity is recorded as unprovable and
never compares equal to anything. Nothing falls back silently to device and
inode only. Folder and executable selection reject such targets up front with
an explicit message. Identities persisted before birth time was recorded
(schema migration 26) read back as unprovable. Those sessions, capabilities,
and profiles stay listable, but every privileged continuation fails closed
until the folder or executable is selected again. Re-reading the current birth
time would bless whatever sits at the path now, so legacy rows are never
backfilled. Canonical-path and containment checks are separate and unchanged.

### Files opened without importing

Opening a file never takes a path from the renderer: main shows the Open
dialog itself or takes a path the operating system delivered (`open-file`,
launch argv, `second-instance` argv). Argv entries are bounded, switches are
ignored, and only supported extensions (case-insensitive) are accepted before
the library's normal import validation runs on the path in main. The file is
copied into a private `<userData>/open-files/<store>` directory (mode 0700) and
read from there; the original is never written. Each opened file has its own
in-memory database and service set, so nothing about it reaches the library
database or the library directory. Disposal cancels its chat streams before
revoking asset registrations and deleting the staged copy, and startup
deletes anything a crashed run left behind. Closed ids keep being refused so
late requests cannot reach the library's stores. Agent Mode is refused for
opened files. Text already sent to an AI provider, and any logs an external
CLI provider keeps itself, are outside Interleaf's control.

## Untrusted document rendering

Interactive document media is a permanent product exclusion. Interleaf never
plays, renders, executes, extracts, or separately archives document-supplied
audio, video, frames, embeds, forms, canvas programs, or equivalent active
content. An original imported container may remain intact as opaque source data;
its embedded media is never exposed as a reader capability. Sanitizers remove
active elements, while inert text/captions and ordinary images follow their
format-specific policies. Both production and development CSP set
`media-src 'none'` as an independent enforcement layer.

PDF.js is configured with XFA disabled and `AnnotationMode.DISABLE`; PDF
embedded scripting is not wired into the adapter. EPUB/MOBI/DOCX content is
parsed in bounded workers where applicable, passed through a strict sanitizer,
and rendered in scriptless `iframe srcdoc` contexts. Scripts, frames, objects,
embeds, forms, event-handler attributes, JavaScript URLs, SVG/remote resources,
and unallowlisted raster content are rejected. DOCX macros, ActiveX, OLE/package
objects, attached toolbars, custom UI, unsafe relationships, and external
resources fail closed. PPTX decks follow the same OOXML policy in their own
worker: macro-enabled types, VBA, OLE, ActiveX, audio/video and external
relationships fail closed, speaker notes and animations are never read, and only
package-internal still images render. Reader adapters do not persist annotations; the main
annotation repository owns annotation data.

ZIP/archive workers and parser workers enforce entry, output, raster, markup,
timeout, and concurrency bounds. Their results are bounded data, not renderer
authority or Node access. DRM-protected EPUB/MOBI content is reported as
unsupported; Interleaf does not attempt circumvention.

### Fenced diagram rendering

A fenced `mermaid` block in a Markdown document is untrusted declarative data.
It is never document-supplied executable code, and drawing one is not an
exception to the permanent active-content exclusion above: what the reader ends
up with is a still picture and the original source text.

The pinned Mermaid build (12.0.0) measures label text with a real layout engine
and ships only `dist/mermaid.core.mjs`, so there is no worker or headless path in
this version that produces correct geometry. Rendering therefore runs in a
separate, terminable, app-owned renderer process (`mermaid-sandbox-window.ts`):
a hidden `BrowserWindow` on a non-persistent session, with no preload and so no
application API, `contextIsolation`, `sandbox`, and `webSecurity` on, navigation,
redirects, popups, and `webview` attachment denied, permission, permission-check,
and device handlers denying everything, and `onBeforeRequest` allowing only URLs
under the built renderer directory the app's own diagram chunks are code-split
into. The page's own CSP is `default-src 'none'` with `script-src 'self'`; there
is no `img-src`, `font-src`, or `connect-src`. All Mermaid chunks are bundled
locally; no CDN, API, or user-configured network rendering exists.

Main owns every bound and every decision (`mermaid-render-service.ts`). Before
dispatch it strips `%%{...}%%` directives and all frontmatter except `title:`.
That removal is a bounded first layer, not the guarantee: the scan stops after 64
directive spans and appends the remainder unchanged, so a source can still carry
directive text to the renderer. What makes the in-source configuration channel
ineffective is the renderer itself, which pins `securityLevel: 'strict'`,
`htmlLabels: false`, theme, fonts, and text budget through Mermaid's own `secure`
list, so a directive that arrives cannot move any of them. Fixed bounds: 20,000
characters and 600 lines of source, 40 diagrams per document, 16 queued jobs, one
render at a time, a 2 MiB output ceiling, an 8,000 px dimension ceiling, and a
6-second deadline. The deadline is not a `Promise.race`: when it fires, main
destroys the renderer's operating-system process, and the next diagram lazily
starts a fresh one. Every job carries a `randomUUID` identity, and a reply naming
a job main has abandoned is discarded rather than displayed.

Output passes three independent layers. The isolated page rebuilds the drawing
from an element/attribute allow-list (`svg-allowlist.ts`) rather than editing it,
unwrapping `<a>` so a hostile `click` directive costs the link and not the
picture. Main then re-scans the serialized markup lexically (`svg-output-guard.ts`),
parsing nothing and refusing rather than repairing: doctypes, DTDs, processing
instructions, comments, CDATA, `script`/`foreignObject`/`use`/`image`/`a` and
other active elements, `on*` and reference attributes, `javascript:`/`vbscript:`,
`data:text/html`, nested SVG data URLs, `@import`, CSS `expression(`,
`-moz-binding`, non-built-in entity references, remote and protocol-relative
URLs, and any `url(...)` that is not a same-document fragment. The reader then
paints the accepted markup as the `src` of an `<img>`; no renderer SVG is ever
inserted into privileged UI, which leaves the existing raw document SVG rejection
and the application CSP untouched.

The isolation this buys is Chromium's renderer sandbox plus a network-denied,
API-free session: a strong boundary against the diagram library mishandling
hostile input. It is not isolation from a hostile process already running as this
user, and is not claimed as such.

### Diagrams in AI output

A fenced `mermaid` block in a chat answer or in agent output is model output and
just as untrusted. It is drawn on a separate, smaller path than document
diagrams: the pinned [Pele](https://github.com/obsidianmd/pele) renderer (1.10.0),
which needs no DOM, runs in a dedicated Web Worker started from the app's own
bundle (`components/markdown/diagram/`). This is a thread inside the main window's
renderer process, not a separate process, so the boundary is narrower than the
document path's. The worker has no preload, no `interleafAPI` and no DOM. Pele
is bundled locally, and nothing on this path makes a network request.

The app, never the source, sets every render option: links and images are off,
their scheme lists are empty, and there are no icon or math callbacks. Fixed
bounds:

- source: 8,000 characters and 300 lines, checked before dispatch and again in
  the worker, plus Pele's own cap of 200 edges;
- output: 400,000 characters of SVG and 4,000 px per side;
- per message: six diagrams;
- queue: 24 jobs, one render at a time;
- deadline: 4 seconds. When it fires, the worker is terminated rather than
  raced, and the next diagram starts a fresh one. Unmounting or a changed source
  cancels a job, and a reply for an abandoned job is discarded.

Rendering waits until a reply has finished streaming and the fence is closed.

Worker replies are validated at runtime. The SVG is then rebuilt on the UI thread
by the same element and attribute allow-list as the document path
(`svg-allowlist.ts`), and the only colours added afterwards are the app's own
theme values. The result is shown only as the `src` of an `<img>`, so no
model-supplied markup enters the DOM. A failure shows a fixed generic sentence
and the escaped source; Pele's error messages, which quote the source, are never
displayed. Unlike the document path, there is no separate main-process lexical
re-scan: here, the allow-list rebuild plus `<img>` inertness is the guarantee.

## Credentials and privacy

OpenRouter credentials are accepted only through the narrow validated
`credentials:set` operation and encrypted with Electron `safeStorage` in the
main process. Raw keys are never returned to the renderer, stored in plaintext
SQLite/JSON, included in prompts, copied to unrelated agent environments, or
written to diagnostics. If secure storage is unavailable, the credential path
fails closed. Subscription-backed CLIs own their authentication; Interleaf
never asks for passwords or extracts browser cookies.

ADR 0009 §5's backend policy is enforced, not merely documented.
`CredentialVault.describeStorage()` records `safeStorage.getSelectedStorageBackend()`
as a non-secret diagnostic (`{ available, backend, platform }` — no key material,
no path; `os_keychain` on macOS/Windows, the probed name on Linux, `unknown` when
it cannot be read) and `credentials:get-status` projects it to Settings as
`storageBackend`. A write or read refuses with the same `security-violation` when
encryption is unavailable *or* Linux selected the plaintext-equivalent `basic_text`
backend; only removal still works without it. Settings then disables the key field
and explains the remedy (install and unlock `gnome-keyring`) instead of offering a
save that main will reject — see `credentialStorageNotice` in
`src/renderer/features/settings/credential-storage-ux.tsx`.

Settings needs to show *which* key is saved, so `credentials:get-status` returns
a masked projection alongside `configured`: `{ prefix: 'sk-or-v1', lastFour }`,
derived in main by `src/main/ai/openrouter-credential-status.ts` from the
decrypted secret. At most the constant public prefix and four trailing
characters cross the bridge, and only for a key that already matches the
documented grammar. Derivation fails closed to `null` when encryption is
unavailable, decryption fails, or the stored value is malformed. The preload
bridge validates the *whole* response with the strict
`openRouterCredentialStatusSchema` before it reaches the renderer: `configured`
must be a boolean, an unconfigured credential may not carry a preview, extra
fields are rejected, and anything else fails as a typed internal error rather
than crossing the boundary. The renderer additionally re-validates the preview
with `parseOpenRouterKeyPreview` and treats anything unexpected as
"no preview". The preview lives in component state only — it is
never logged, persisted in renderer settings, or placed in a prompt or an agent
environment. A replacement key exists in the renderer only while the user is
typing it into the password field, and is discarded once the save completes.

Because derivation fails closed, `{ configured: true, keyPreview: null }` means
a credential is stored but could not be read. Settings reports that state
truthfully — `openRouterCredentialState` in
`src/renderer/features/settings/provider-rows.ts` maps it to `stored-unreadable`, so
the row reads "Saved key unreadable", the key chip reads "Unreadable" rather
than "Saved", and the connection test is disabled because the credential cannot
serve a call.

Both recovery paths from that state work without reading the stored secret,
because it is exactly the secret that cannot be read:

- **Removal** is its own main-owned operation, `credentials:clear`. It takes
  only `{ providerId: 'openrouter' }` and is routed through the provider that
  owns the credential — dispatcher to `ChatService.clearOpenRouterCredential`
  to `OpenRouterProvider.clearCredential` — so it runs under the same lock as
  `configure` rather than on a second, unserialized path to the vault. It drops
  the record from the vault document, re-checks that it is gone, and answers
  with the same masked status projection — never a secret or ciphertext. It
  decrypts nothing and does not
  require `safeStorage` to be available, so an undecryptable or malformed-base64
  ciphertext clears exactly like a readable one. A vault document that cannot be
  parsed at all still fails closed rather than being overwritten, so records
  whose contents were never established are not destroyed speculatively
  (ADR 0009 §6). Settings applies the result in place, so the panel drops to the
  unconfigured state immediately; a failed deletion keeps the configured or
  unreadable state visible and surfaces a safe error.
- **Replacement** overwrites the stored ciphertext without reading it. The key
  editor is one password input in every state — absent, readable, or unreadable —
  holding only what the reader is typing now; the masked preview is displayed
  beside it and is never fed back in as the input's value.

`configure` writes the two stores in a fixed order: the non-secret model setting
first, the vault second. Neither store is transactional across the other, so one
side has to be the compensable one. Restoring a previous *model* needs only the
value already in hand, while restoring a previous *key* would require the old
plaintext — a secret the user is discarding, and the very thing that is
unavailable in the unreadable case. So a failed vault write compensates the
settings change and leaves the credential exactly as the user found it, and a
failed settings write ends the operation before the vault is touched. If
compensation itself fails, the error says so instead of claiming a consistent
state.

Every credential-store mutation the provider owns — replacement and removal
alike — is queued on one promise chain in `OpenRouterProvider`. The vault is a
read-modify-write of a single document, so two overlapping mutations could
otherwise lose an update and then each report a state that is not the one on
disk. Whichever operation is requested second observes the first one's
completed result, and that ordering is enforced in main: a same-tick or hostile
renderer cannot interleave a deletion with a replacement. Settings also
disables Remove while a save is in flight and Done while a removal is in
flight, but that is a usability guard on top of the authoritative lock, not the
mechanism.

## AI and prompt-injection controls

`src/main/ai/provenance-serializer.ts` builds the `<document>` envelope using a
DOM serializer. Titles, attributes, source text, and locations are assigned as
typed data, not interpolated markup. The Reader AI system prompt labels
document text as untrusted reference data and gives it no tool, filesystem,
network, or shell authority. Claude and OpenRouter use tool-free/API chat
paths; connected ChatGPT is also selectable for Reader Chat through an
explicitly user-authorized constrained Codex path. That Codex transport is
**not genuinely tool-free** and remains `toolFreeMode=false`: main resolves the
canonical binary, creates a private empty app-owned cwd, passes the read-only
sandbox with `approval_policy="never"`, ignores user config/rules, and uses a
minimal allowlisted environment. I/O and wall-clock time are bounded,
cancellation terminates the process tree, and any unsupported Codex tool/event
causes a fail-closed abort before its payload is rendered. This is residual-risk
containment authorized by the user, not a guarantee that Codex's tool surface
has been removed. Pi is a fourth Reader Chat provider on the same transport and
is genuinely tool-free (`toolFreeMode=true`): it is launched shell-free with
tokenized argv in a private empty app-owned cwd under `--mode json --print
--no-tools --no-extensions --no-skills --no-prompt-templates --no-themes
--no-context-files --no-session --no-approve --offline`, with the Reader AI
prompt installed via `--system-prompt` and the append slot emptied so no
user- or project-owned `APPEND_SYSTEM.md` can extend it. `--offline` suppresses
Pi's startup, update, catalog and telemetry traffic; it does not disable the
selected remote model request. The document, history and question travel on
stdin and are never argv tokens; only a validated `provider/model` identifier
from Pi's own listing becomes one. Any `tool_execution_*` or `toolcall_*` event
is a fail-closed violation that terminates the process before its payload is
rendered, and unknown or malformed structured output never becomes assistant
text. The Reader AI prompt is not repeated in that stdin body: Pi
already holds it as a system prompt, so the turn data carries only the
document context, history and question. Readiness is probed without emitting a
credential or starting inference (`pi auth check --provider <p> --json
--no-refresh`, never `--credentials`), and the probe fails closed: `ready` is
concluded only from a clean exit 0, while the documented not-ready rejection is
read only when the process exited 1 on its own with no signal, kill, timeout or
`maxBuffer` abort, and can only downgrade the verdict. A ready-shaped payload
carried by any other failure is `unknown`, never connected. Binary paths,
tokens, account details and raw probe output stay out of the renderer and the
logs.

Omp (`omp/18.1.16`) is a fifth Reader Chat provider on the same transport, with
the same posture and one honest difference. It is launched shell-free with
tokenized argv in a private empty app-owned cwd under `--mode json --print
--no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules
--no-session --no-title --approval-mode always-ask`, the Reader AI prompt
installed via `--system-prompt` with the append slot emptied, and the document,
history and question carried only on stdin. **Omp has no `--offline` flag.**
Interleaf therefore claims tool-free chat — no tools, extensions, skills, rules,
session or project context, and no app-granted filesystem or tool execution —
and claims nothing about Omp's own network behaviour. Only assistant
`text_delta` events become text, a terminal `agent_end`/`turn_end` is required,
and tool activity is a fail-closed violation. Detection uses `omp models --json
--no-extensions`, which emits no credential and invokes no model; that catalog
is untrusted and is validated, bounded, deduped and capped before exposure.

The `local` provider connects to an inference server on this machine. Its
security property is the destination of the socket, and that is enforced once,
in main, by a deliberately narrow policy: `http` only, a **literal** loopback
authority (`127.0.0.1` or `[::1]`), no userinfo, path, query or fragment. Names
such as `localhost` are refused because a name is resolved and a resolver is
what a rebinding attack needs. Requests use a private `node:http` agent, which
honours no proxy environment, follows no redirect and performs no name lookup
(the installed `lookup` hook always fails), against fixed app-owned paths built
from the canonicalized origin — never a path from configuration. The renderer
does hold the endpoint *text*, because Settings is where the user types it, and
it runs the shared parser locally only to show an error while typing; it holds
no socket and issues no request, and its validation carries no authority. Main
re-parses and canonicalizes the submitted string and persists only the canonical
origin, so a renderer that submitted an unchecked or dishonest value would be
refused by the same policy rather than trusted. Connect, idle and overall
timeouts apply, the idle and overall deadlines stay armed after response headers
(Node's socket timeout only reports inactivity, so the transport closes the
socket itself and fails the waiting reader with a typed error), and the total
byte, per-line byte and line-count bounds are enforced against raw chunks as
they arrive rather than after a line is framed — so a body that never sends a
newline is cut off at the cap instead of being accumulated past it. Cancellation
and cleanup apply throughout, and responses are treated as untrusted program
output: catalogs are
validated, bounded and deduped, and the stream exposes only
`choices[0].delta.content`, so reasoning fields never reach the renderer or
storage. No `tools`, `functions`, `tool_choice` or MCP field is sent, a
tool-shaped delta or finish reason aborts the turn, and a forged `webSearch:
true` is refused before a socket opens. Interleaf never downloads, pulls,
starts, stops or deletes a model or runtime, and the connection test lists
models without inference. No local API token is stored: none is required by the
supported loopback servers, and adding one would mean holding a credential the
architecture does not need. **The claim is loopback-only connection, not
on-device inference:** Ollama may route a cloud-capable model to its own
servers, which Interleaf can neither control nor detect, so Settings states this
and points at Ollama's `OLLAMA_NO_CLOUD=1` rather than implying a guarantee.

Antigravity remains an Agent Mode integration. Citation IDs
are resolved against the exact source set stored for the chat message; unknown
IDs remain inert.

Agent handoff prompts likewise escape the user task and document quote. The
renderer constructs a typed context packet; main validates its schema and
persists it under app-owned context storage. Document instructions cannot grant
additional filesystem, network, or process privileges.

## Agent process and workspace controls

`src/main/agents/process-runner.ts` is the canonical owner of subprocesses and
the only main/preload module allowed to import `child_process` at runtime.
Callers outside `ProcessRunner` use its `execFileBounded` (one-shot: required
finite timeout and output cap) or `spawnPiped` (long-lived piped child whose
caller enforces its own bounds); both pin `shell: false` and take tokenized argv.
`ProcessRunner` uses `spawn(file, argv, { shell: false })`, closes stdin when
appropriate, bounds input/output/event sizes, enforces explicit finite
timeouts where callers request them, and escalates process-group termination
on POSIX. User agent runs carry no total wall-clock deadline: they end when
the child exits, the user cancels, or the application shuts down; bounded
probes, helper runs, and tests pass their own finite timeouts. Child
environments are constructed from an allowlist; parent `process.env` and
Interleaf secrets are not copied wholesale. On macOS the child and lookup PATH
appends a fixed set of existing well-known CLI install directories (per-user
`.local`/`.bun`/nvm and Homebrew/`/usr/local`) to the inherited PATH, because a
Finder launch inherits only the OS GUI PATH; no shell, startup file, or
workspace-supplied location contributes, and an explicit per-run PATH override
still wins. Agent output is redacted at the
child boundary and again before persistence or renderer delivery. Redaction
covers only explicitly registered secret values (the runner request's
`redactValues`; there is no production caller that registers run secrets)
plus credential shapes: private key blocks, bearer headers, token shapes, and
secret assignments. Environment delivery never implies secrecy: per-run
override values and the expert-shell `INTERLEAF_*` metadata are ordinary
local diagnostics, as are ambient inherited values. Ordinary local filesystem
locations (workspace, target, executable, cwd, context files) and ambient
inherited environment values (HOME, PATH, TMPDIR, SHELL, ...) are deliberately
not redacted, so users keep readable command and error diagnostics from their
own machine; nothing the child did not output is dumped.

`auto-isolated` resolves in main to a Git worktree or non-Git directory copy.
Preparation failure never falls back to a direct workspace. Worktrees and
copies are workspace isolation only: a dangerous CLI can still reach host
resources available to its OS user unless a stronger boundary exists.

`native-restricted` and `active-env` require a fresh, single-use grant bound to
the exact sender, mode, profile fingerprint, effective policy, opaque directory
handle, target identity, and draft. Native Restricted additionally requires a
main-owned capability probe. Active Environment is direct HIGH/CRITICAL risk.
The current `container-sandbox` mode is unavailable and fails closed even if a
Docker/Podman client or daemon is detected; no verified bounded rootless
executor is configured, and no fallback is permitted.

The environment manager rejects overlapping target scopes during preparation,
including nested directories and a Git repository/subdirectory pair. Separate
non-overlapping targets may run concurrently. Apply/discard revalidate target
identity and are held behind the target lock. Apply requires a terminal,
reaped session, blocks dirty/drifted Git targets, rejects symlink/collision
changes, stages directory-copy replacements, and retains app-owned recovery
journals for rollback. Unknown recovery records are not recursively deleted,
and a pending Git-cleanup record that is malformed or unreadable is
distinguished from an absent one: it retains both the session root and the
external Git registration for explicit repair rather than authorizing removal.

Workspace scanning is offloaded to bounded worker threads
(`src/main/agents/snapshot-worker.ts`) that carry no authority of their own: a
worker may only read a canonical root main added to an exact-path allow-list
immediately before dispatch and revoked immediately after, it holds no database
handle, credential, renderer channel, or native API, and every record it
returns is re-validated and re-judged by policy in main before it can become a
manifest entry. Workers are capped at two concurrent with a bounded queue, a
timeout, and late-result rejection. Cancellation is carried from real session
lifecycle operations — each session's `AbortController` is threaded into every
dispatch for it and aborted by a discard or a failed prepare — so a scan is
cancelled whether it is queued or running. The pool belongs to the environment
manager, not to module state, and `AgentService.shutdown` drains in two phases:
admission closes immediately and permanently for that service lifecycle,
already-admitted work gets a bounded grace, then dispatch closes permanently, so
no later owner or lifecycle work can start another scan. Main
validates the shape and bounds of a returned hash; the hash value itself is
trusted because the worker source is main-authored and main-dispatched.

Every relative path crossing a manifest, recovery, or diff boundary is
validated by segment decomposition (`src/main/agents/relative-path.ts`): no
NUL or C0 control character, `/` as the only separator with backslashes
rejected rather than normalized, no absolute, UNC, or drive-relative prefix,
and no empty, overlong, `.`, or `..` segment. Ordinary names containing `..`
as a substring remain legal, so the validator is not a substring search in
either direction.

Symbolic links are representable only as no-follow metadata for a link the
frozen Git index records as tracked: the link string is read with `readlink`,
bounded, refused when absolute or escaping the subtree, and hashed as the link
string. A link's destination is never opened during snapshot, review, Apply,
cleanup, or recovery; a created, removed, or repointed link fails Apply closed,
re-checked inside the apply transaction and not only in the earlier review; and
non-Git trees still reject every symbolic link.

Recovery backups are bounded (per-file and cumulative bytes, entry count,
depth, and directory fan-out) and copied through `O_NOFOLLOW` opens with
before/after `fstat` identity and ownership comparison, writing in a loop over
`bytesWritten` so a partial write cannot silently truncate the only copy of the
user's data. A budget is consumptive, so the backup pass, validation, and
restoration each get their own: charging all three to one allowance made a
legitimate restore fail on arithmetic *after* the target was gone. The ordering
that matters is unchanged and now actually proved — the complete restore set is
validated by reading every backup byte before the first target is removed, since
an `lstat` and a successful `open` say nothing about a truncated or unreadable
file.

Preparation is journaled with an `fsync`/`rename` record, and `manifest.json`
and `tracked-index.json` are themselves fsynced and renamed, with their parent
directory fsynced, before the journal phase that claims them. Ownership is not
self-asserted: a UUID inside the session root proves nothing about a subtree an
agent writes to. Each journal carries an HMAC-SHA256 over its canonical fields,
keyed by a main-created installation marker held outside the agent environment
root (`src/main/agents/preparation-owner.ts`) and opened `O_NOFOLLOW` as a
private app-owned regular file. Startup removes only an uncommitted root whose
MAC verifies against this installation's marker and which names that exact root;
a foreign or borrowed installation id, a replayed or malformed MAC, and an
unsigned record are all retained. A session whose metadata claims a frozen index
and has no readable index record fails closed rather than being read as a legacy
name-only environment. This is a forgery boundary against renderer-, workspace-
and model-writable data, not OS isolation: a process running as the same user
with unrestricted filesystem reach can read the marker.

Custom profiles are edited in Settings, but the renderer retains only an opaque
executable handle/display name/fingerprint. Main persists the versioned config
and executable identity, revalidates device/inode/birth-time/size/mtime/SHA-256 before
execution, and rejects changed binaries. Selection and rehydration stream the
bounded file through a worker-thread hasher with before/after identity checks
and a timeout; an asynchronous worker verification runs immediately before
adapter startup, while the adapter's synchronous guard performs only bounded
canonical-path and metadata checks. A narrow same-user path replacement race
remains between this final validation and `spawn`; custom executable paths
inside the prepared workspace are rejected to prevent the agent from
self-swapping its executable.

Profiles are strictly discriminated by `executionKind`:
- **Normal mode**: Strict tokenized argv templates, `shell: false`, and no command strings. Rejects shell-only fields, direct shell binaries (`sh`, `bash`, `zsh`, `pwsh`, `cmd`, etc.), and direct shell eval flags (`-c`, `/c`, `-Command`).
- **Expert shell mode**: Separate dangerous path executing a verified shell binary with fixed family arguments (`-lc COMMAND`, `-NoProfile -NonInteractive -Command COMMAND`, `/d /s /c COMMAND`) and Node `shell: false`. No command string interpolation of user prompts, document text, or filesystem paths. Delivery is strictly `stdin`. Main-owned runtime values are exposed as minimal environment variables (`INTERLEAF_SESSION_ID`, `INTERLEAF_RUN_ID`, `INTERLEAF_MODEL`, `INTERLEAF_REASONING_EFFORT`, `INTERLEAF_WORKING_DIR`); they are ordinary local diagnostics, so a child that prints them stays readable while credential-shaped output still redacts. Requires dedicated native warning on creation/transition and for every execution-authority edit (shell family/commands or executable path/identity; selecting a new opaque handl…
When a custom profile uses temp-file prompt delivery, main writes at most a
256 KiB prompt to an owner-only 0600 file in the private
`agent-workspaces/context/custom-prompts/` directory. Completion removes the file when
possible; startup cleanup is symlink-aware, examines at most 512 directory
entries, and removes only matching regular files older than 24 hours.

## Diagnostics

`src/main/logging/logger.ts` writes bounded JSONL records under owner-only
`<userData>/logs/`, rotates the current file through three retained files, and
serializes writes. It redacts credential/token/private-key shapes, home paths,
document/prompt/context bodies, and raw stdout/stderr fields. Debug records are
off unless explicitly enabled, either by `INTERLEAF_DEBUG_LOGS=1` or by the
reader in Settings › Advanced (`advanced.debugLogging`, default off). That
preference moves only the level filter: the destination, size bounds, rotation
and redaction of the sink are fixed when it is configured, so enabling debug
records adds detail to the same bounded, redacted local log and never widens
what may be written. The native export dialog writes a bounded,
re-sanitized bundle and accepts no renderer-provided destination path.

This is distinct from the persisted agent event stream: the session UI may show
bounded, redacted stdout/stderr events so the user can monitor a run, while
durable application diagnostics exclude raw streams by design.

## Application updates

Updates are an install path, so they are treated as untrusted input until a
signature proves otherwise:

- **Fixed destination, fixed key.** The origin, release repository, product id
  and Ed25519 public keys are compiled into main (`src/main/updates/update-trust.ts`).
  No setting, environment variable, IPC payload or downloaded file can change
  them, and no key is fetched. Production builds from 0.5.0 pin the
  bootstrapped release key (id `b448deb8c896ef18`); only its public half is in
  the source. A build that pins no key fails closed: it reports "not
  configured" and sends no request. A renamed development bundle
  (`process.defaultApp` set) counts as development and never contacts the
  feed.
- **Signed manifest first.** The app parses nothing from a release until the
  detached signature over the manifest bytes verifies against a pinned key.
  It then requires the product id, the stable channel, the platform, the
  architecture and a strictly newer version. GitHub's release metadata and
  electron-updater's own `latest*.yml` are never consulted. The artifact URL is
  derived from the verified tag and file name on the same origin, and
  electron-updater checks every byte against the signed SHA-512. A mismatch
  discards the download and reports a fixed "failed its authenticity or
  integrity check" message.
- **macOS defence in depth.** Squirrel.Mac additionally refuses a bundle whose
  code signature does not satisfy the running app's designated requirement.
- **No credentials.** Requests carry no token or cookie. The signing key lives
  outside the repository, CI, artifacts and logs. The release tool refuses a
  key inside the checkout, one readable by other users, or one not pinned in
  the source it releases.
- **User control.** Checks can be turned off. Downloads and restarts happen
  only on explicit actions. A restart refuses while agent, chat or import work
  is active, counted by the owning services rather than database rows. Once
  idle, it reserves the shutdown barrier and closes every service's admission
  in one synchronous step, before the renderer flush, so no new chat, import,
  open or agent run can start during the handshake. It then passes the normal
  shutdown barrier. Renderer-visible state is a validated, fixed-copy summary with no
  path, URL or raw error text. The release page opens through main with a URL
  fixed in code.
- **Package-manager installs are left alone.** deb and pacman installs, Windows,
  development runs and any unrecognised layout never contact the feed.
- **Smoke builds.** `INTERLEAF_UPDATE_SMOKE_TRUST` exists only for the packaged
  update smoke. It is accepted only for a `http://127.0.0.1:<port>` origin with
  exactly one key, and any other value pins no key. Both release commands
  refuse to run while it is set.

Residual limits: anyone holding the signing key can publish an update every
installed build accepts until a release drops that key. A promoted release
cannot be withdrawn from builds that have already downloaded it. Rotation and
bootstrap are documented in [Packaging ▸ Update signing key](PACKAGING.md#update-signing-key).

## Verification references and residual limits

Security-sensitive regression coverage is in:

- `tests/unit/security.spec.ts`, `path-security.spec.ts`,
  `protocol-handler.spec.ts`, and `ipc-audit.spec.ts`;
- `tests/unit/ebook-security.spec.ts`, `prompt-injection.spec.ts`,
  `credential-vault.spec.ts`, and `logger.spec.ts`;
- `tests/unit/agent-runtime.spec.ts`, `agent-environment.spec.ts`,
  `agent-service.spec.ts`, `working-directory-registry.spec.ts`, `working-directory-capabilities.spec.ts`, `cross-event-redaction.spec.ts`, and `tests/integration/agent-environment-workflow.spec.ts`;
- `tests/unit/agent-manifest-paths.spec.ts`,
  `agent-recovery-backup.spec.ts`, `agent-preparation-journal.spec.ts`,
  `agent-git-index-metadata.spec.ts`, `agent-snapshot-worker.spec.ts`, and
  `agent-provider-contracts.spec.ts`;
- reader and security workflows under `tests/e2e/`.

The 2026-08-27 verification snapshot records green `npm run lint`,
`npm run typecheck`, and `npm run build`; Vitest `npm test` at 113 files / 1457
tests; integration at 9 files / 69 tests; and the D21 focused suite at 3 files
/ 76 tests. No live paid ChatGPT reply or D21 normal/200% screenshot was
validated. The latest full Electron discovery sweep recorded 73 passed and 30
skipped with `--retries=0`; Workflow H was subsequently characterized in three
isolated zero-retry runs.

Remaining boundaries include same-user filesystem races, direct Active
Environment execution after explicit confirmation, and the security behavior
of third-party CLI binaries. Container containment is not currently a
mitigation because its executor is intentionally absent. Two further limits are
stated rather than claimed away: snapshot hash *values* computed on a worker
thread are trusted because that worker source is main-authored and
main-dispatched (main validates their format and bounds, not their arithmetic),
and the `pi` Agent Mode profile still declares a non-interactive capability
that no repository evidence proves — an open product decision.
