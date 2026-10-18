# ADR 0011: Custom Protocol Asset Loading & Path Security

## Status
Accepted

## Context & Problem Statement
The sandboxed renderer process needs to load local document media (PDF binary streams, extracted EPUB images, DOCX drawings, and generated book covers). Using the native `file://` protocol in Electron requires disabling web security flags or exposing arbitrary local filesystem paths to the renderer DOM, creating high-severity local file inclusion (LFI) and path traversal vulnerabilities.

## Decision Drivers
- Enable safe, streaming media loading in the sandboxed renderer.
- Strict enforcement of Chromium's Same-Origin Policy and Content Security Policy.
- Prevention of path traversal attacks (e.g. `interleaf-media:///../../../etc/passwd`).
- Conformance with the `electron-development` skill protocol handling rules.

## Considered Options
1. **Option 1: Base64 Data URLs over IPC** — Convert all document pages and images to Base64 strings and send them over IPC. (Rejected: 33% memory bloat, high serialization latency for large PDFs).
2. **Option 2: Native `file://` Protocol** — Allow renderer to reference local file paths directly. (Rejected: Disables web security, enables arbitrary filesystem reading).
3. **Option 3: Privileged Custom Scheme (`interleaf-media://`) with Opaque Asset Capabilities** — Register a custom scheme with standard/secure privileges. Renderer URLs contain random asset IDs, while main resolves and validates canonical paths against the active document's permitted roots.

## Decision Outcome
Chosen **Option 3**.

### Architectural Invariants
1. **Scheme Registration**:
   ```typescript
   protocol.registerSchemesAsPrivileged([
     { scheme: 'interleaf-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
   ]);
   ```
2. **Opaque, Scoped Resolution**:
   ```typescript
   protocol.handle('interleaf-media', async (request) => {
     const url = new URL(request.url);
     const assetId = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
     const asset = await assetRegistry.resolveForRequest(assetId, request);
     const [root, candidate] = await Promise.all([
       realpath(asset.permittedRoot),
       realpath(asset.canonicalPath),
     ]);
     const relative = path.relative(root, candidate);
     if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
       return new Response('Forbidden', { status: 403 });
     }
     // openVerifiedAsset uses O_NOFOLLOW on POSIX and post-open identity plus
     // canonical-path revalidation on every platform. Phase 3 ingestion owns
     // staging policy; the protocol registry itself does not infer a digest
     // from a filename.
     const handle = await openVerifiedAsset(root, candidate);
     return streamAssetWithRangeAndMime(handle, asset.mimeType, request);
   });
   ```
3. **Registry Rules**: Asset IDs are unguessable, short-lived, bound to the active renderer/document scope, and never expose host paths. Switching documents revokes the previous document's capabilities. Only app-managed media roots are registrable; link-in-place content stages required reader assets into managed storage first. The Phase 3 ingestion service is responsible for hash-addressed managed documents and immutable reader staging; the registry validates roots, regular-file identity, extension-derived MIME, scope, and expiry, but intentionally does not treat a filename as proof of a digest. Registry insertion and lookup reject symlink escapes, periodic sweeping removes expired entries, and window/session close revokes its entire scope. Access uses no-follow where supported, rechecks device/inode identity against a final contained canonical path, and streams only the verified handle. Windows lacks a portable `openat2`/open-beneath primitive in Node, so the security boundary also relies on the staging root remaining main-owned and unwritable by renderer or document content; same-user processes are outside that guarantee.
4. **Streaming Rules**: Responses support bounded streaming, one validated byte range, allowlisted MIME types, cancellation, and deterministic handle closure; large files are never read wholly into memory. Request and response headers use explicit allowlists rather than forwarding arbitrary values.
5. **CSP Integration**: The CSP explicitly allows `img-src 'self' interleaf-media: data: blob:;` and `media-src 'self' interleaf-media:;`.

## Consequences
- **Positive**: High-performance binary streaming of large PDFs and ebook assets without memory overhead.
- **Positive**: Opaque handles and canonical containment materially reduce local-file disclosure and traversal risk.
- **Negative**: Requires careful maintenance of the active permitted root paths whitelist in the main process.
- **Negative**: Cross-platform Node file APIs do not provide a uniform kernel-level open-beneath primitive; immutable app-owned staging plus post-open identity checks are required, and a hostile same-user process is outside this protocol boundary.
