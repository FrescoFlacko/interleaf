# Interleaf marketing website

This is the static homepage for Interleaf. It is separate from the Electron app;
nothing under `website/` is bundled into the application.

| File | Purpose |
| --- | --- |
| `index.html` | The page. It is complete without JavaScript. |
| `styles.css` | All styling and motion. Motion is disabled under `prefers-reduced-motion`. |
| `site.config.json` | Download URLs for the two macOS `.dmg` builds. `null` means coming soon. |
| `assets/screens/` | Optimised WebP screenshots at 960, 1600 and 2400 px. |
| `assets/brand/` | Icons resized from `resources/icon.png`. |
| `demo-library.json` | The only books the screenshots may contain, with their SHA-256 hashes. |
| `PROVENANCE.md` | Sources, editions, licence evidence and attribution for those books. |
| `FEATURES.md` | Links every claim on the page to the source or wiki that supports it. |
| `wrangler.jsonc` | Optional Cloudflare Workers static-assets config. It holds no secrets and has not been deployed. |
| `../website.build.ts` | Builds the site into `out/website`. |
| `../website.client.ts` | Progressive enhancement: scroll reveals, the header section indicator, and the screenshot viewer. |
| `../website.screens.ts` | Turns raw captures into the WebP files and icons. |
| `../tests/e2e/website-screenshots.spec.ts` | Captures the screenshots from the real app. It is opt-in. |

All commands below run from the repository root.

## Build and preview

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON website.build.ts
python3 -m http.server --directory out/website --bind 127.0.0.1 4174
```

Open <http://127.0.0.1:4174/> and stop the server with `Ctrl+C` when done.

`out/` is gitignored. The builder writes `out/website/.interleaf-website-build.json`
and will only ever clear the files that marker lists. It refuses non-empty
folders it did not create, protected project folders, and paths through
symbolic links. To build somewhere else, pass `--out <directory>`.

## Wiring the download buttons

The download host is still pending, so both URLs stay `null` for now. Public
installers will be published on a separate host, never from the source
repository. [Stable updates](../docs/PACKAGING.md#stable-updates) describes the
chosen destination, GitHub Releases in the public releases-only repository
`FrescoFlacko/interleaf-releases`, its release procedure and the asset
existence check to run before configuring a URL.

Once the host exists and every asset has been checked, put the published URLs
in `site.config.json` (placeholders shown):

```json
{ "downloads": { "macos-arm64": "https://<download-host>/<arm64-asset>.dmg", "macos-x64": "https://<download-host>/<x64-asset>.dmg" } }
```

Then rebuild. Each configured button becomes a real `<a href>` link, and its
"Coming soon" note changes to a beta note. The build fails on any value that is
not an `https://` URL ending in `.dmg`, and on any URL containing credentials.
A key left at `null` stays a disabled button, announced with `aria-disabled`
and a visible "Coming soon" label.

## Reproducing the screenshots

The capture uses a fresh temporary Interleaf profile created by the E2E helpers.
It never touches an existing library.

1. Download the four demo books into a scratch folder, named by their manifest
   `id`, and verify them:

   ```bash
   mkdir -p /tmp/interleaf-site/books /tmp/interleaf-site/captures
   cd /tmp/interleaf-site/books
   curl -fL -o erickson-algorithms.pdf https://jeffe.cs.illinois.edu/teaching/algorithms/book/Algorithms-JeffE.pdf
   curl -fL -o morin-ods-java.pdf https://opendatastructures.org/ods-java-screen.pdf
   curl -fL -o gutenberg-28885.epub https://www.gutenberg.org/ebooks/28885.epub3.images
   curl -fL -o gutenberg-57532.epub https://www.gutenberg.org/ebooks/57532.epub3.images
   shasum -a 256 *
   cd -
   ```

   Compare the hashes with `website/demo-library.json`. The capture spec checks
   them again and stops on any mismatch. If a publisher has since changed a
   file, verify its licence again and update both the manifest and
   `PROVENANCE.md`.

2. Build the app, then capture. The chat answer is a stubbed fixture, so no
   provider is contacted:

   ```bash
   npm run build
   INTERLEAF_SITE_BOOKS_DIR=/tmp/interleaf-site/books \
   INTERLEAF_SITE_CAPTURE_DIR=/tmp/interleaf-site/captures \
   npx playwright test tests/e2e/website-screenshots.spec.ts
   ```

3. Check every PNG by eye, then optimise them into `website/assets`:

   ```bash
   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON website.screens.ts --from /tmp/interleaf-site/captures
   ```

4. Delete `/tmp/interleaf-site` when finished.

Without the two environment variables, the spec skips itself. The ordinary E2E
suite therefore never downloads or imports anything.

## Checks

```bash
npx vitest run tests/unit/website
```

These tests cover:

- the download wiring and URL validation;
- that every referenced image exists and every image has `alt`, `width` and
  `height`;
- that no inline script or remote resource is used;
- that no home-directory path appears in a shipped file;
- that provenance covers every manifest book;
- that the evidence paths in `FEATURES.md` exist;
- the output-directory refusals.

## Optional Cloudflare deployment (not performed)

The build output is self-contained static files. `_headers` sets the Content
Security Policy and related headers, and `.assetsignore` keeps the build marker
out of the upload. Deploying requires your own Cloudflare account:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON website.build.ts
npx wrangler deploy --config website/wrangler.jsonc
```

`wrangler` is not a project dependency. `npx` fetches it when you run it.
