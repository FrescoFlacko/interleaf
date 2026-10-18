# Wiki website

The user wiki is written once, in Markdown, under `docs/wiki/`. A small build
script renders those files into a static website. There is no second copy of the
content: the Markdown is the source of truth, and the site is generated output.

## Build and preview

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON wiki.build.ts
python3 -m http.server --directory out/wiki 4173
# open http://127.0.0.1:4173/
```

`out/` is ignored by Git and by ESLint, so a built site never shows up in the
working tree or in `npm run lint`. Write the site somewhere else with `--out`:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON wiki.build.ts --out ../wiki-preview
```

`--disable-warning=...` only silences Node's notice about running TypeScript from
a package without `"type": "module"`; the build works without it.

Any static file server works — the pages are plain `.html` files with relative
links, so nothing needs URL rewriting.

### What the build may write to

A rebuild never deletes a directory it does not own. The output directory must
be one of:

* a path that does not exist yet (it is created);
* an empty directory; or
* the output directory of a previous build, recognized by the
  `.interleaf-wiki-site.json` marker it leaves behind. Only the files that
  marker lists are replaced; anything else you put there is left alone.

Anything else — a non-empty directory the generator did not write, the project
root or one of its parents, `src/`, `docs/`, `tests/`, a filesystem root, or any
path that reaches its target through a symbolic link — is refused before a
single file is touched.

Every path a build would delete or write, down to the bundled
`assets/wiki.js`, is checked first, including the directories along the way: a
generated folder replaced by a link, a destination that is not a plain file, or
a file the generator did not write stops the build before it deletes or writes
anything at all.

## Hosting

Copy the contents of `out/wiki/` to any static host. The site works from the
root of a domain and from a subdirectory (`https://example.test/help/`) with no
configuration: every asset, navigation link and search result is a relative
path, and `<html data-base>` tells the browser script where the site root is.

Direct loads and reloads of a deep URL (`/help/formats/pdf.html#tables`) work,
because each page is a real file rather than a client-side route.

## Files

| File | What it is |
| --- | --- |
| `docs/wiki/**/*.md` | The content. Edit here. |
| `wiki.build.ts` | The generator: renders Markdown, builds the navigation, search index and pages. |
| `wiki.images.ts` | Screenshot support: which image references are allowed, and reading them safely. |
| `wiki.search.ts` | Ranking and snippet logic, shared by the build and the browser. |
| `wiki.client.ts` | Browser script: search, mobile menu, contents highlighting. |
| `wiki-site/styles.css` | The stylesheet, copied to `out/wiki/assets/wiki.css`. |
| `tests/unit/wiki-site/` | Rendering, whole-site build, link, search, output-safety and contrast tests. |

## Editing the wiki

Edit the Markdown and rebuild. Ordinary Markdown works: headings, tables, fenced
code, blockquotes and links. Raw HTML is escaped rather than rendered
(`<kbd>` is the one exception), and `javascript:` or `data:` link targets are
dropped, so pasted content cannot introduce script into the site.

Headings get anchors matching GitHub's slugs, so `[link](reading.md#display-settings)`
resolves both on GitHub and on the site.

### Adding a page

1. Add the Markdown file under `docs/wiki/`.
2. Add it to `NAVIGATION` in `wiki.build.ts`, with the label the sidebar should
   show. The build fails if a wiki page is missing from the navigation, so a new
   page can never be silently unreachable.
3. Rebuild.

### Links

* Links between wiki pages (`reading.md`, `../ai-chat.md#attaching-context`)
  become site routes automatically.
* Links to the developer documents the wiki references (`ARCHITECTURE.md`,
  `SECURITY.md` and the others listed under "Project documentation" in
  `NAVIGATION`) are rendered as pages too, under `project/`.
* A link to a repository file that has no page becomes inert text naming the
  file, never a dead route or a filesystem path. The build fails if an internal
  link or heading anchor does not resolve.

### Screenshots

A page may show screenshots from `website/assets/screens/`, the same files the
project website uses, so the wiki never carries its own stale copies. Write the
image as a relative path from the page, with an optional caption in italics on
the next line:

```markdown
![The library with four demo books](../../website/assets/screens/library-1600.webp)
*The library with four openly licensed demo books.*
```

The build copies each referenced screenshot to `assets/screens/` in the output,
rewrites the link to match the page's depth, and turns an image with a caption
into a figure. Only those screenshots are copied, and they are recorded in the
output's ownership marker like every other generated file.

The rules are strict, and the build fails rather than guessing:

* Only plain relative paths that resolve to a file directly inside
  `website/assets/screens/` are accepted, with a lowercase `.webp`, `.png`,
  `.jpg` or `.jpeg` name. Remote URLs, `data:` and other schemes, absolute
  paths, `..` escapes, encoded characters, queries and fragments are refused.
* The file must be a regular file of at most 5 MiB whose contents match its
  type. Symbolic links, for the file or any directory above it, are refused.
* Raw HTML `<img>` stays escaped like any other raw HTML, and an image that
  reaches the rendered page by any other route is removed.

Every screenshot must come from the documented capture; see
[`website/PROVENANCE.md`](../website/PROVENANCE.md).

### Headings and contents

The site generates the breadcrumb, the sidebar, the "On this page" contents and
the previous/next links. Pages do not need to write them by hand; where the
Markdown still contains a hand-written breadcrumb line or an "On this page"
block, the build removes it so it is not shown twice.

## Search

Search covers page titles and the full article text. The build writes the index
to `out/wiki/assets/search-index.js`; the browser loads it with the page, so
search works offline and needs no server or external service. Results link to
the nearest heading and show a snippet with the matched words marked.

## Checks

```bash
npx vitest run tests/unit/wiki-site   # rendering, links, search, output safety, contrast
npm run lint
npm run typecheck
```
