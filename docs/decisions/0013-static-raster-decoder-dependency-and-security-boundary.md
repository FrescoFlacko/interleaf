# ADR 0013: Static Raster Decoder Dependency and Security Boundary

## Status
Accepted

## Context & Problem Statement
Interleaf imports public web articles for offline reading, annotation, full-text search, and AI context (ADR 0012). Web articles frequently contain figures, charts, and photographs formatted in common web raster formats beyond PNG, including JPEG, WebP, GIF, and AVIF.

Under ADR 0012, media admission was temporarily restricted strictly to PNG rasters because Interleaf lacked an approved, production-grade offline image decoding dependency. Pure-JS segment walkers (such as partial JPEG header parsers) cannot reliably validate full image entropy streams and are susceptible to malformed payloads, while full image decoding without an approved dependency is mathematically complex and error-prone.

To allow subsequent feature work to ingest standard editorial imagery safely, Interleaf requires a production-quality, Electron-compatible static raster decoding engine with an explicit security boundary.

## Decision Drivers
- **Comprehensive Format Support**: Ability to decode standard web raster formats (PNG, JPEG, WebP, GIF, AVIF).
- **Electron & Packaging Compatibility**: Zero required build-from-source steps in standard environments; prebuilt Node-API (`napi`) binaries for macOS (arm64, x64), Linux (x64, arm64), and Windows (x64, arm64); seamless integration with Electron Builder ASAR packaging and `@electron/rebuild`.
- **Process Isolation & Attack Surface Containment**: Image decompression and parsing must execute inside isolated worker threads, never in the main process thread or untrusted renderer process.
- **Strict Invariants on Multi-Frame and Vector Content**: Strict rejection of multi-frame or animated media (animated GIF, animated WebP, animated AVIF), vector graphics (SVG), and interactive media (video, audio, canvas).
- **Deterministic Storage Canonicalization**: All admitted static raster images must be transcoded/canonicalized to safe, standardized PNG bytes before being committed to content-addressed managed storage.
- **Supply Chain & Runtime Hygiene**: Dependency must not introduce install lifecycle scripts (`postinstall`, etc.) or unsafe ambient runtime behavior.

## Considered Options
1. **Option 1: In-Tree Pure-JavaScript Decoders (`jpeg-js`, `omggif`, etc.)** — Use lightweight JavaScript decoding libraries. (Rejected: Incomplete format coverage, particularly for modern formats like AVIF/WebP; significantly higher CPU and memory overhead; vulnerable to memory exhaustion and algorithmic complexity attacks on large inputs).
2. **Option 2: Offscreen Chromium / HTML5 Canvas Decoding** — Spin up headless renderer or offscreen browser contexts to decode images via native browser engines. (Rejected: Violates process separation by involving browser rendering engines with wide attack surfaces; high resource overhead; difficult to enforce strict memory and decompression bounds).
3. **Option 3: Pinned `sharp` (0.35.4) Dependency with libvips** — Integrate `sharp` pinned exactly to `0.35.4` as a production dependency. (Chosen: Industry standard, highly optimized, memory-efficient libvips engine with extensive fuzzing and security hardening; prebuilt Node-API binaries for all target Electron architectures; no postinstall build scripts; full native support for PNG, JPEG, WebP, GIF, and AVIF).

## Decision Outcome
Chosen **Option 3: Pinned `sharp` (0.35.4)**.

### Architectural & Security Invariants
1. **Pinned Dependency**:
   - `sharp` is pinned to exact version `0.35.4` in `package.json` with no caret (`^`) or tilde (`~`) range.
   - Prebuilt platform binaries (`@img/sharp-*` and `@img/sharp-libvips-*`) are pulled via optional dependencies matching the target platform, avoiding custom native compilation scripts.
   - Package verification confirms zero install scripts (`preinstall`, `install`, `postinstall`) in the published package manifest.

2. **Supported Formats**:
   - The approved decoder dependency supports exactly five static raster formats:
     - **PNG**
     - **JPEG**
     - **WebP** (static only)
     - **GIF** (static single-frame only)
     - **AVIF** (static only)

3. **Multi-Frame and Animation Rejection**:
   - Animated or multi-frame images are strictly prohibited in Interleaf documents.
   - Subsequent feature code must inspect image metadata (e.g., `pages`, frame count, animation flags) and immediately reject any image containing more than one frame (`pages > 1`) fail-closed.
   - Animated GIFs, animated WebP, and animated AVIF/HEIF sequences are rejected; no frame extraction or partial animation acceptance is permitted.

4. **Permanent Exclusions**:
   - **SVG Prohibited**: SVG remains strictly forbidden. It is an active XML markup format capable of script execution, external resource references, and parser exploits; it must not be parsed or rasterized.
   - **Interactive Media Prohibited**: Audio, video, HTML embeds, forms, canvas programs, and other active media remain permanently excluded per AGENTS.md, ADR 0011, and ADR 0012.

5. **Worker Thread Isolation & Resource Limits**:
   - All decoding operations must execute in dedicated Node worker threads (`worker_threads`). Neither the main process event loop nor the renderer process may invoke `sharp` directly.
   - Hard resource limits must be enforced on decoding:
     - Maximum input wire size: 8 MB per file.
     - Decoded dimensions: bounded between 32 px and 20,000 px per side, with an aggregate maximum of 40,000,000 pixels. Inputs claiming or decoding to dimensions outside these bounds fail closed before full decompression.
     - Per-request and per-article timeout deadlines propagated to worker tasks.

6. **Canonicalization to PNG**:
   - Admitted images from all supported formats (PNG, JPEG, WebP, GIF, AVIF) will be canonicalized to deterministic, re-encoded PNG bytes before persistent storage.
   - The stored snapshot references only the content-addressed SHA-256 hash of the canonical PNG (`interleaf-asset:<sha256>.png`). Original untrusted format bytes are discarded after validation and transcoding.

7. **Scope Boundary**:
   - This architectural decision record and its associated work unit govern solely the dependency addition, Electron packaging compatibility, and security policy specification. Application feature code, worker integration, and decode pipelines are deferred to subsequent feature work units.

## Consequences
- **Positive**: Enables subsequent feature work to safely support all common web article imagery (PNG, JPEG, WebP, GIF, AVIF) without sacrificing editorial fidelity.
- **Positive**: High decoding throughput and low memory footprint powered by libvips.
- **Positive**: Predictable, script-free dependency tree compatible with Electron Builder packaging across macOS, Windows, and Linux.
- **Negative**: Native binary platform packages increase application distribution archive size.
- **Negative**: Feature implementation must enforce strict validation against multi-frame images and adhere strictly to worker thread boundaries.
