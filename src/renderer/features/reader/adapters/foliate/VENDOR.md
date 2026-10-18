# Vendored foliate-js Subset

## Provenance

- **Upstream**: https://github.com/johnfactotum/foliate-js
- **Pinned commit**: `78914aef4466eb960965702401634c2cb348e9b1`
- **License**: MIT (`./LICENSE`, © John Factotum)
- **Vendor date**: 2026-08

## Why vendored instead of pinned via npm

The `foliate-js@1.0.1` npm artifact is a stale third-party publication from a
different maintainer and does not track current upstream. It must not be used.
The upstream repository itself is active and unstable (no releases), so a raw
lockfile pin of a git dependency would silently change rendering/security
behavior on every install. Vendoring an audited subset is therefore the
explicit choice — this is **not** an upstream pin.

## Files

| File | Upstream source | Local hardening |
|---|---|---|
| `epub.ts` | `epub.js` | DOMPurify sanitization before any DOM insertion; malformed/unknown DRM metadata fails closed; font obfuscation is accepted only for manifest-declared font media; external URL stripping; blob-URL lifecycle |
| `upstream/mobi.js` | `mobi.js` (exact pinned source plus marked bounds) | Full MOBI6/KF8/HUFF parser; per-record and aggregate decoded-size, index, metadata, dictionary, recursion, and FDST bounds |
| `mobi.ts`, `mobi-parse-core.ts`, `mobi-parse.worker.ts` | Interleaf wrapper | Typed isolation; envelope/record/DRM validation; parse/decompression/DOM reconstruction, signature-checked raster materialization, and structural prefilter in a two-slot, queue-abortable, 30-second worker; 8 MiB section/32 MiB aggregate markup caps; mandatory DOMPurify runs lazily before active-section `srcdoc` and again in-frame. Worker DOM primitives use exact dependency `linkedom@0.18.13` (ISC). |
| `epubcfi.ts` | `epubcfi.js` | Strict TypeScript port; point/range, escape, ordering, and `FILTER_SKIP` regression coverage |
| `paginator.ts` | `paginator.js` | sanitized `srcdoc`; iframe locked to `sandbox="allow-same-origin"` (**never** `allow-scripts`); all content link navigation blocked; Interleaf typography/palette injection only; top-visible caret CFI/fraction relocation and restoration |
| `view.ts` | `view.js` | Coordinator reduced to section navigation/search/styles |
| `overlayer.ts` | `overlayer.js` | SVG-only overlay custom element |
| `progress.ts` | `progress.js` | Section/TOC progress estimation |
| `search.ts` | `search.js` | Unmodified algorithm |
| `text-walker.ts` | `text-walker.js` | Skips `script`/`style`/`noscript` subtrees |
| `zip-inflate-core.ts`, `zip-inflate.worker.ts`, `zip-loader.ts` | (replaces `zip.js`) | fflate-backed dedicated worker (two concurrent jobs, queue-aware cancellation, 30-second timeout); pre-inflate entry/size bomb limits; path-traversal rejection |
| `sanitize.ts` | (Interleaf original) | Strict DOMPurify policy: strips scripts, frames, form controls, `on*` handlers, `javascript:` URIs, remote `http(s)` URLs |

## Security invariants (docs/SECURITY.md §4)

1. Ebook content never executes script: sanitizer strips active content and
   the iframe sandbox omits `allow-scripts`.
2. No network access from book content: remote URLs are removed at sanitize
   time; internal resources are re-served as blob URLs.
3. Archives are size- and path-bounded before parse.
4. DRM-protected files fail closed with a user-safe error; Interleaf never
   attempts circumvention.
5. Ebook archive inflation and MOBI/KF8 parsing/decompression never execute on
   the renderer event loop. Worker jobs are concurrency- and time-bounded and
   terminate on completion, failure, timeout, or reader cancellation.

## Updating

1. Diff each upstream `.js` file against the pinned commit.
2. Re-apply every hardening listed above; do not port upstream changes
   blindly.
3. Re-run: `npm run lint && npm run typecheck && npm run test &&
   npm run test:e2e`.
4. Bump the pinned commit hash here and in the per-file headers together.
