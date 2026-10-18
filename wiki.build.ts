/**
 * Static site generator for the Interleaf wiki.
 *
 * The Markdown under `docs/wiki/` stays the single source of truth: this script
 * renders it into a self-contained static website in `out/wiki/` that any web
 * server (or the Sites connector) can host, including from a subdirectory.
 *
 * Run it with Node's built-in TypeScript support:
 *
 *   node wiki.build.ts
 *   python3 -m http.server --directory out/wiki 4173
 *
 * Nothing here touches the Electron application: the site is plain HTML, one
 * stylesheet and one small bundled script.
 */
import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import type { PortableMember, PortableRecord, PortableValue } from './src/shared/models/portable';
import type * as WikiImages from './wiki.images';

/**
 * Node runs this file with type stripping, which needs the `.ts` extension on a
 * relative import; the TypeScript config rejects that extension in a static
 * specifier, so the sibling module is loaded dynamically and typed statically.
 */
const wikiImagesModule = './wiki.images.ts';
const { IMAGE_OUTPUT_DIR, dropNonLocalImages, pageImages, placeImages, readWikiImage } = (await import(wikiImagesModule)) as typeof WikiImages;

/*
 * `linkedom` is the project's server-side DOM; it types its parsed window with
 * the standard DOM interfaces, so the transforms below are written against
 * `Document` and `Element` and never touch a browser global.
 */

/** A page in the generated site, keyed by its path relative to `docs/`. */
export type PageRef = {
  /** Source path relative to `docs/`, e.g. `wiki/formats/pdf.md`. */
  readonly source: string;
  /** Output route relative to the site root, e.g. `formats/pdf.html`. */
  readonly route: string;
};

export type NavSection = {
  readonly title: string;
  readonly items: readonly NavItem[];
};

export type NavItem = {
  /** Source path relative to `docs/`. */
  readonly source: string;
  /** Sidebar label; the page's own `# heading` is used for everything else. */
  readonly label: string;
  readonly children?: readonly NavItem[];
};

export type TocEntry = {
  readonly id: string;
  readonly text: string;
  readonly level: number;
};

export type IndexHeading = {
  readonly id: string;
  readonly text: string;
  readonly offset: number;
};

export type SearchDocument = {
  readonly route: string;
  readonly title: string;
  readonly section: string;
  readonly headings: readonly IndexHeading[];
  readonly text: string;
};

export type RenderedPage = {
  readonly source: string;
  readonly route: string;
  readonly title: string;
  readonly section: string;
  readonly description: string;
  readonly html: string;
  readonly toc: readonly TocEntry[];
  readonly anchors: ReadonlySet<string>;
  readonly links: readonly string[];
  readonly text: string;
  readonly headings: readonly IndexHeading[];
  /** Screenshot file names the page shows, copied into `assets/screens/`. */
  readonly images: readonly string[];
};

export type BuildOptions = {
  /** Repository root that contains `docs/` and `wiki-site/`. */
  readonly projectRoot: string;
  /** Directory the site is written to; it is replaced on every build. */
  readonly outDir: string;
  /** Bundling the browser script needs Vite, so tests can opt out of it. */
  readonly bundleClient?: boolean;
};

export type BuildResult = {
  readonly pages: readonly RenderedPage[];
  readonly assets: readonly string[];
};

const HOME_SOURCE = 'wiki/README.md';
const SITE_NAME = 'Interleaf';
const SITE_TAGLINE = 'Read. Think. Build.';
const WIKI_NAME = 'Interleaf Wiki';

/**
 * Sidebar order. It mirrors the table of contents in `docs/wiki/README.md`; the
 * wiki home page is always the first entry and is added separately.
 */
const NAVIGATION: readonly NavSection[] = [
  {
    title: 'Getting started',
    items: [
      { source: 'wiki/quick-start.md', label: 'Quick start' },
      { source: 'wiki/installation.md', label: 'Installation' },
      { source: 'wiki/navigation.md', label: 'App navigation' },
      { source: 'wiki/keyboard-shortcuts.md', label: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Your library',
    items: [
      { source: 'wiki/adding-documents.md', label: 'Adding documents' },
      {
        source: 'wiki/formats/README.md',
        label: 'Document formats',
        children: [
          { source: 'wiki/formats/pdf.md', label: 'PDF' },
          { source: 'wiki/formats/epub.md', label: 'EPUB' },
          { source: 'wiki/formats/mobi-kindle.md', label: 'MOBI and Kindle' },
          { source: 'wiki/formats/docx.md', label: 'DOCX (Word)' },
          { source: 'wiki/formats/pptx.md', label: 'PPTX (PowerPoint)' },
          {
            source: 'wiki/formats/markdown-and-web-articles.md',
            label: 'Markdown and web articles',
          },
        ],
      },
    ],
  },
  {
    title: 'Reading',
    items: [
      { source: 'wiki/reading.md', label: 'Reading a document' },
      { source: 'wiki/highlights-and-notes.md', label: 'Highlights and notes' },
    ],
  },
  {
    title: 'AI',
    items: [
      {
        source: 'wiki/ai-providers.md',
        label: 'AI providers',
        children: [
          { source: 'wiki/providers/chatgpt-subscription.md', label: 'ChatGPT (subscription)' },
          { source: 'wiki/providers/claude-code.md', label: 'Claude Code' },
          { source: 'wiki/providers/openrouter.md', label: 'OpenRouter' },
          { source: 'wiki/providers/local-server.md', label: 'Local server' },
          { source: 'wiki/providers/pi.md', label: 'Pi' },
          { source: 'wiki/providers/omp.md', label: 'Omp' },
          { source: 'wiki/providers/antigravity.md', label: 'Antigravity' },
          { source: 'wiki/providers/agent-only-clis.md', label: 'OpenCode' },
        ],
      },
      { source: 'wiki/ai-chat.md', label: 'AI Chat' },
      { source: 'wiki/ai-agent.md', label: 'AI Agent' },
    ],
  },
  {
    title: 'Help',
    items: [
      { source: 'wiki/help-and-troubleshooting.md', label: 'Help and troubleshooting' },
      { source: 'wiki/faq.md', label: 'FAQ' },
    ],
  },
  {
    // The wiki links to these developer documents, so they are rendered too:
    // a link that leaves the wiki must still reach a real page.
    title: 'Project documentation',
    items: [
      { source: 'ARCHITECTURE.md', label: 'Architecture' },
      { source: 'SECURITY.md', label: 'Security' },
      { source: 'AI_ARCHITECTURE.md', label: 'AI architecture' },
      { source: 'AGENT_RUNTIME.md', label: 'Agent runtime' },
      { source: 'DOCUMENT_FORMATS.md', label: 'Document formats (technical)' },
      { source: 'PACKAGING.md', label: 'Packaging' },
    ],
  },
];

/* ------------------------------------------------------------------ paths */

/** Maps a `docs/`-relative Markdown path to its route in the built site. */
export function routeForSource(source: string): string {
  const withoutDocs = source.startsWith('wiki/') ? source.slice('wiki/'.length) : `project/${source}`;
  const lower = withoutDocs.replace(/\.md$/u, '').toLowerCase();
  return lower.endsWith('readme') ? `${lower.slice(0, -'readme'.length)}index.html` : `${lower}.html`;
}

/** `formats/pdf.html` is two levels deep, so its assets live at `../assets/`. */
export function assetPrefix(route: string): string {
  const depth = route.split('/').length - 1;
  return depth === 0 ? '' : '../'.repeat(depth);
}

/** Relative href from one route to another, usable from a static host. */
export function relativeHref(fromRoute: string, toRoute: string): string {
  const fromDir = posix.dirname(`/${fromRoute}`);
  const href = posix.relative(fromDir, `/${toRoute}`);
  return href === '' ? posix.basename(toRoute) : href;
}

/* ------------------------------------------------------------------- text */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** GitHub-compatible heading slug, so anchors written in Markdown keep working. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

function uniqueSlug(text: string, used: Set<string>): string {
  const base = slugify(text) || 'section';
  let candidate = base;
  let counter = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${String(counter)}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** JSON that is safe to embed in a `<script>` element. */
export function embeddableJson(value: PortableValue): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

/* --------------------------------------------------------------- markdown */

const KEPT_INLINE_HTML = /^<\/?kbd>$/iu;

function escapeRawHtml(raw: string): string {
  return KEPT_INLINE_HTML.test(raw.trim()) ? raw : escapeHtml(raw);
}

/**
 * Markdown is rendered with raw HTML escaped rather than passed through. Beyond
 * the obvious injection risk, HTML-looking placeholders such as `<title>` in the
 * prose would otherwise be parsed as elements and swallow the text after them.
 */
function createMarkdown(): Marked {
  const engine = new Marked({ gfm: true });
  engine.use({
    renderer: {
      html(token: { readonly text?: string }): string {
        return escapeRawHtml(token.text ?? '');
      },
    },
  });
  return engine;
}

const ALLOWED_TAGS: readonly string[] = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'del',
  'code', 'pre', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'kbd', 'sup', 'sub', 'span', 'div', 'img',
];
const ALLOWED_ATTR: readonly string[] = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'colspan', 'rowspan', 'start', 'align',
];
/**
 * Relative links, fragments, `https:` and `mailto:` only. The trailing branches
 * are DOMPurify's idiom for "has no URI scheme", which keeps `ai-chat.md` while
 * still rejecting `javascript:` and every other scheme.
 */
const SAFE_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/iu;

/** Elements whose text must disappear with them rather than be kept as prose. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'video', 'audio', 'canvas', 'template', 'title', 'link', 'meta', 'svg', 'math',
]);

/**
 * Enforces the element and attribute allowlist on parsed Markdown output.
 *
 * Markdown is already rendered with raw HTML escaped, so this is the second of
 * two independent barriers: whatever reaches the page is an element on the list,
 * with an allowed attribute, and a link target with no scheme or a safe one.
 */
export function sanitizeElement(element: Element): void {
  for (const child of [...element.children]) sanitizeElement(child);
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const allowed = ALLOWED_ATTR.includes(name) && !name.startsWith('on');
    if (!allowed || ((name === 'href' || name === 'src') && !SAFE_URI.test(attribute.value.trim()))) {
      element.removeAttribute(attribute.name);
    }
  }
  const tag = element.tagName.toLowerCase();
  if (ALLOWED_TAGS.includes(tag)) return;
  if (DROP_WITH_CONTENT.has(tag)) element.remove();
  else element.replaceWith(...element.childNodes);
}

/**
 * Renders Markdown to sanitized HTML with no scripts, styles or event handlers.
 * Only Markdown images with a plain relative path survive; the build then
 * accepts exactly the allowlisted screenshots among them (`wiki.images.ts`).
 */
export function renderMarkdown(markdown: string): string {
  const raw = createMarkdown().parse(markdown, { async: false });
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${raw}</body></html>`);
  for (const child of [...document.body.children]) sanitizeElement(child);
  dropNonLocalImages(document.body);
  return document.body.innerHTML;
}

/* ------------------------------------------------------- article rewriting */

type ArticleContext = {
  readonly source: string;
  readonly route: string;
  readonly routes: ReadonlyMap<string, string>;
};

/** Removes the Markdown breadcrumb line; the page renders a real breadcrumb. */
function stripBreadcrumb(body: HTMLElement): void {
  const first = body.firstElementChild;
  if (first?.tagName !== 'P' || !first.textContent.includes('›')) return;
  if (first.querySelector('a') === null) return;
  first.remove();
}

/** Removes the hand-written "On this page" list in favour of the generated one. */
function stripInlineToc(body: HTMLElement): void {
  for (const element of [...body.children]) {
    const label = element.textContent.trim().toLowerCase();
    if (label !== 'on this page') continue;
    const isHeading = /^H[1-6]$/u.test(element.tagName);
    const isBoldParagraph = element.tagName === 'P' && element.querySelector('strong') !== null;
    if (!isHeading && !isBoldParagraph) continue;
    const list = element.nextElementSibling;
    element.remove();
    if (list?.tagName === 'UL' || list?.tagName === 'OL') list.remove();
    return;
  }
}

function addHeadingAnchors(body: HTMLElement, document: Document): TocEntry[] {
  const used = new Set<string>();
  const toc: TocEntry[] = [];
  for (const heading of body.querySelectorAll('h2, h3, h4')) {
    const text = heading.textContent.trim();
    const id = uniqueSlug(text, used);
    heading.setAttribute('id', id);
    const anchor = document.createElement('a');
    anchor.className = 'heading-anchor';
    anchor.setAttribute('href', `#${id}`);
    anchor.setAttribute('aria-label', `Link to section: ${text}`);
    anchor.textContent = '#';
    heading.append(anchor);
    const level = Number.parseInt(heading.tagName.slice(1), 10);
    if (level <= 3) toc.push({ id, text, level });
  }
  return toc;
}

/** Wide comparison tables stay usable on a phone as a focusable scroll region. */
function wrapTables(body: HTMLElement, document: Document): void {
  for (const table of body.querySelectorAll('table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', 'Table, scrollable');
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

function markCodeBlocks(body: HTMLElement): void {
  for (const pre of body.querySelectorAll('pre')) {
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('role', 'region');
    const code = pre.querySelector('code');
    const language = /language-([\w-]+)/u.exec(code?.className ?? '')?.[1];
    pre.setAttribute('aria-label', language === undefined ? 'Code sample' : `Code sample, ${language}`);
    if (language !== undefined) pre.setAttribute('data-language', language);
  }
}

export type LinkResolution =
  | { readonly kind: 'internal'; readonly href: string }
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'unresolved'; readonly target: string };

/**
 * Turns a Markdown link into a link the site can serve. Fragments and external
 * URLs pass through; `.md` targets become routes; anything that would be a dead
 * route (or a file path) is reported so the caller can render inert text.
 */
export function resolveLink(href: string, context: ArticleContext): LinkResolution {
  if (href.startsWith('#')) return { kind: 'internal', href };
  if (/^https?:\/\//iu.test(href)) return { kind: 'external', href };
  if (/^mailto:/iu.test(href)) return { kind: 'external', href };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//')) {
    return { kind: 'unresolved', target: href };
  }
  const [path, fragment] = splitFragment(href);
  if (path === '') return { kind: 'unresolved', target: href };
  const target = posix.normalize(posix.join(posix.dirname(context.source), path));
  const route = context.routes.get(target);
  if (route === undefined) return { kind: 'unresolved', target };
  const base = route === context.route ? '' : relativeHref(context.route, route);
  const suffix = fragment === '' ? '' : `#${fragment}`;
  return { kind: 'internal', href: base + suffix || '#' };
}

function splitFragment(href: string): readonly [string, string] {
  const index = href.indexOf('#');
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index + 1)];
}

function rewriteLinks(body: HTMLElement, document: Document, context: ArticleContext): string[] {
  const internal: string[] = [];
  for (const anchor of body.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? '';
    const resolved = resolveLink(href, context);
    if (resolved.kind === 'internal') {
      anchor.setAttribute('href', resolved.href);
      internal.push(resolved.href);
      continue;
    }
    if (resolved.kind === 'external') {
      anchor.setAttribute('href', resolved.href);
      anchor.setAttribute('rel', 'noopener noreferrer nofollow');
      anchor.setAttribute('target', '_blank');
      anchor.className = 'external-link';
      continue;
    }
    // Nothing on the site can serve this target, so name the repository file
    // instead of emitting a broken route.
    const replacement = document.createElement('span');
    replacement.className = 'repo-reference';
    replacement.setAttribute('title', `Repository file: ${resolved.target}`);
    replacement.textContent = anchor.textContent === '' ? resolved.target : anchor.textContent;
    anchor.replaceWith(replacement);
  }
  return internal;
}

const BLOCK_TAGS = new Set([
  'p', 'li', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'td', 'th', 'tr', 'div',
]);
/** Marks a block boundary while the text is collected; collapsed afterwards. */
const BLOCK_BREAK = '\u0000';
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Plain text of the article, used for search snippets. Block boundaries become
 * a visible separator so a snippet never runs a heading into the next sentence,
 * and the generated heading anchors are left out of the text entirely.
 */
function articleText(body: HTMLElement): string {
  const parts: string[] = [];
  const visit = (node: ChildNode): void => {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    if (element.className === 'heading-anchor') return;
    const block = BLOCK_TAGS.has(element.tagName.toLowerCase());
    if (block) parts.push(BLOCK_BREAK);
    for (const child of element.childNodes) visit(child);
    if (block) parts.push(BLOCK_BREAK);
  };
  for (const child of body.childNodes) visit(child);
  return parts
    .join('')
    .replace(/\s+/gu, ' ')
    .replace(/(?: ?\u0000 ?)+/gu, ' — ')
    .replace(/^ — /u, '')
    .replace(/ — $/u, '')
    .trim();
}

function headingOffsets(body: HTMLElement, text: string): IndexHeading[] {
  const headings: IndexHeading[] = [];
  let cursor = 0;
  for (const heading of body.querySelectorAll('h2, h3')) {
    const id = heading.getAttribute('id');
    const label = heading.textContent.replace(/#$/u, '').replace(/\s+/gu, ' ').trim();
    if (id === null || label === '') continue;
    const offset = text.indexOf(label, cursor);
    if (offset >= 0) cursor = offset;
    headings.push({ id, text: label, offset: offset >= 0 ? offset : cursor });
  }
  return headings;
}

function firstParagraph(body: HTMLElement): string {
  for (const paragraph of body.querySelectorAll('p')) {
    const text = paragraph.textContent.replace(/\s+/gu, ' ').trim();
    if (text.length > 40) return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }
  return `${WIKI_NAME} — ${SITE_TAGLINE}`;
}

/* ------------------------------------------------------------- templates */

type SiteModel = {
  readonly pages: readonly RenderedPage[];
  readonly order: readonly string[];
  readonly sections: ReadonlyMap<string, string>;
  readonly parents: ReadonlyMap<string, string>;
  readonly byRoute: ReadonlyMap<string, RenderedPage>;
};

function navLink(item: NavItem, page: RenderedPage, model: SiteModel, depth: number): string {
  const route = routeForSource(item.source);
  const current = route === page.route;
  const href = escapeHtml(relativeHref(page.route, route));
  const ancestor = !current && model.parents.get(page.route) === route;
  const classes = ['nav-link', `nav-depth-${String(depth)}`];
  if (current) classes.push('is-current');
  if (ancestor) classes.push('is-ancestor');
  const aria = current ? ' aria-current="page"' : '';
  const children = item.children ?? [];
  const sublist = children.length === 0
    ? ''
    : `<ul class="nav-sublist">${children.map((child) => navLink(child, page, model, depth + 1)).join('')}</ul>`;
  return `<li><a class="${classes.join(' ')}" href="${href}"${aria}>${escapeHtml(item.label)}</a>${sublist}</li>`;
}

function renderSidebar(page: RenderedPage, model: SiteModel): string {
  const home = routeForSource(HOME_SOURCE);
  const homeCurrent = page.route === home;
  const sections = NAVIGATION.map((section) => {
    const id = `nav-${slugify(section.title)}`;
    const items = section.items.map((item) => navLink(item, page, model, 1)).join('');
    return `<h2 class="nav-heading" id="${id}">${escapeHtml(section.title)}</h2>
      <ul class="nav-list" aria-labelledby="${id}">${items}</ul>`;
  }).join('');
  return `<nav id="site-nav" class="sidebar" aria-label="Documentation sections">
    <ul class="nav-list nav-home">
      <li><a class="nav-link nav-depth-1${homeCurrent ? ' is-current' : ''}" href="${escapeHtml(relativeHref(page.route, home))}"${homeCurrent ? ' aria-current="page"' : ''}>Wiki home</a></li>
    </ul>
    ${sections}
  </nav>`;
}

function renderBreadcrumb(page: RenderedPage, model: SiteModel): string {
  const home = routeForSource(HOME_SOURCE);
  const crumbs: string[] = [];
  if (page.route !== home) {
    crumbs.push(`<li><a href="${escapeHtml(relativeHref(page.route, home))}">${escapeHtml(WIKI_NAME)}</a></li>`);
    const section = model.sections.get(page.route);
    if (section !== undefined) crumbs.push(`<li><span>${escapeHtml(section)}</span></li>`);
    const parent = model.parents.get(page.route);
    const parentPage = parent === undefined ? undefined : model.byRoute.get(parent);
    if (parentPage !== undefined) {
      crumbs.push(`<li><a href="${escapeHtml(relativeHref(page.route, parentPage.route))}">${escapeHtml(parentPage.title)}</a></li>`);
    }
  }
  crumbs.push(`<li><span aria-current="page">${escapeHtml(page.title)}</span></li>`);
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><ol>${crumbs.join('')}</ol></nav>`;
}

function renderToc(page: RenderedPage): string {
  if (page.toc.length < 3) return '';
  const items = page.toc
    .map((entry) => `<li class="toc-level-${String(entry.level)}"><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`)
    .join('');
  return `<aside class="toc" aria-labelledby="toc-heading">
    <details class="toc-details" open>
      <summary id="toc-heading">On this page</summary>
      <ul class="toc-list">${items}</ul>
    </details>
  </aside>`;
}

function renderPager(page: RenderedPage, model: SiteModel): string {
  const index = model.order.indexOf(page.route);
  const previous = index > 0 ? model.byRoute.get(model.order[index - 1] ?? '') : undefined;
  const next = index >= 0 ? model.byRoute.get(model.order[index + 1] ?? '') : undefined;
  if (previous === undefined && next === undefined) return '';
  const link = (target: RenderedPage, rel: 'prev' | 'next', label: string): string =>
    `<a class="pager-link pager-${rel}" rel="${rel}" href="${escapeHtml(relativeHref(page.route, target.route))}">
      <span class="pager-label">${label}</span>
      <span class="pager-title">${escapeHtml(target.title)}</span>
    </a>`;
  return `<nav class="pager" aria-label="Previous and next page">
    ${previous === undefined ? '<span></span>' : link(previous, 'prev', 'Previous')}
    ${next === undefined ? '<span></span>' : link(next, 'next', 'Next')}
  </nav>`;
}

function renderSearch(): string {
  return `<div class="search">
    <form class="search-form" role="search" action="" novalidate>
      <label class="search-label" for="wiki-search">Search the wiki</label>
      <input id="wiki-search" class="search-input" type="search" name="q" autocomplete="off"
        placeholder="Search pages and text…" aria-describedby="search-hint"
        aria-controls="search-results" aria-expanded="false" />
      <p id="search-hint" class="visually-hidden">Results appear below as you type. Use the down arrow key to move into them.</p>
    </form>
    <div id="search-results" class="search-results" hidden>
      <p class="search-status" role="status" aria-live="polite"></p>
      <ul class="search-list"></ul>
    </div>
    <noscript><p class="search-noscript">Search needs JavaScript. The navigation on the left works without it.</p></noscript>
  </div>`;
}

function renderPageHtml(page: RenderedPage, model: SiteModel): string {
  const prefix = assetPrefix(page.route);
  const home = relativeHref(page.route, routeForSource(HOME_SOURCE));
  const isHome = page.route === routeForSource(HOME_SOURCE);
  const title = isHome ? `${WIKI_NAME} — ${SITE_TAGLINE}` : `${page.title} — ${WIKI_NAME}`;
  return `<!DOCTYPE html>
<html lang="en" class="no-js" data-base="${escapeHtml(prefix)}" data-route="${escapeHtml(page.route)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.description)}" />
<meta name="color-scheme" content="light dark" />
<link rel="stylesheet" href="${escapeHtml(prefix)}assets/wiki.css" />
<script defer src="${escapeHtml(prefix)}assets/search-index.js"></script>
<script defer src="${escapeHtml(prefix)}assets/wiki.js"></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="topbar">
  <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav">
    <span class="nav-toggle-bars" aria-hidden="true"></span>
    <span>Menu</span>
  </button>
  <a class="brand" href="${escapeHtml(home)}">
    <span class="brand-name">${escapeHtml(SITE_NAME)}</span>
    <span class="brand-sub">${escapeHtml(SITE_TAGLINE)}</span>
  </a>
  ${renderSearch()}
</header>
<div class="layout">
  ${renderSidebar(page, model)}
  <main id="main" class="content" tabindex="-1">
    ${renderBreadcrumb(page, model)}
    ${renderToc(page)}
    <article class="article">
${page.html}
    </article>
    ${renderPager(page, model)}
  </main>
</div>
<footer class="site-footer">
  <p>${escapeHtml(SITE_NAME)} documentation — built from the Markdown in <code>docs/wiki/</code>.</p>
</footer>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- build */

function collectNavItems(items: readonly NavItem[], parent: string | undefined, model: {
  order: string[];
  section: Map<string, string>;
  parents: Map<string, string>;
}, sectionTitle: string): void {
  for (const item of items) {
    const route = routeForSource(item.source);
    model.order.push(route);
    model.section.set(route, sectionTitle);
    if (parent !== undefined) model.parents.set(route, parent);
    if (item.children !== undefined) {
      collectNavItems(item.children, route, model, sectionTitle);
    }
  }
}

/** Every page the site renders, in sidebar order, starting at the wiki home. */
export function sitePageRefs(): readonly PageRef[] {
  const refs: PageRef[] = [{ source: HOME_SOURCE, route: routeForSource(HOME_SOURCE) }];
  const walk = (items: readonly NavItem[]): void => {
    for (const item of items) {
      refs.push({ source: item.source, route: routeForSource(item.source) });
      if (item.children !== undefined) walk(item.children);
    }
  };
  for (const section of NAVIGATION) walk(section.items);
  return refs;
}

async function markdownFilesUnder(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await markdownFilesUnder(root, child)));
    } else if (entry.name.endsWith('.md')) {
      found.push(child);
    }
  }
  return found;
}

/** Fails the build when a wiki page would be silently dropped from the site. */
export async function assertAllWikiPagesIncluded(docsRoot: string): Promise<void> {
  const files = await markdownFilesUnder(docsRoot, 'wiki');
  const included = new Set(sitePageRefs().map((ref) => ref.source));
  const missing = files.filter((file) => !included.has(file));
  if (missing.length > 0) {
    throw new Error(`Wiki pages missing from the site navigation: ${missing.join(', ')}`);
  }
}

function firstHeading(body: HTMLElement, fallback: string): string {
  const heading = body.querySelector('h1');
  const text = (heading?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  if (heading !== null) heading.remove();
  return text === '' ? fallback : text;
}

async function renderPage(
  ref: PageRef,
  docsRoot: string,
  routes: ReadonlyMap<string, string>,
  sectionTitle: string,
): Promise<RenderedPage> {
  const markdown = await readFile(join(docsRoot, ...ref.source.split('/')), 'utf8');
  // Throws on any image that is not an allowlisted local screenshot.
  const images = pageImages(markdown, ref.source);
  const sanitized = renderMarkdown(markdown);
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${sanitized}</body></html>`);
  const body = document.body;
  stripBreadcrumb(body);
  const title = firstHeading(body, ref.source);
  stripInlineToc(body);
  const toc = addHeadingAnchors(body, document);
  wrapTables(body, document);
  markCodeBlocks(body);
  placeImages(body, document, images, (name) => relativeHref(ref.route, `${IMAGE_OUTPUT_DIR}/${name}`));
  const links = rewriteLinks(body, document, { source: ref.source, route: ref.route, routes });
  const text = articleText(body);
  const headingElements = headingOffsets(body, text);
  const anchors = new Set(toc.map((entry) => entry.id));
  for (const heading of body.querySelectorAll('[id]')) {
    const id = heading.getAttribute('id');
    if (id !== null) anchors.add(id);
  }
  return {
    source: ref.source,
    route: ref.route,
    title,
    section: sectionTitle,
    description: firstParagraph(body),
    html: `<h1 class="article-title">${escapeHtml(title)}</h1>\n${body.innerHTML}`,
    toc,
    anchors,
    links,
    text,
    headings: headingElements,
    images: [...new Set(images.values())],
  };
}

/** Verifies every internal link resolves to a real page and anchor. */
export function assertLinksResolve(pages: readonly RenderedPage[]): void {
  const byRoute = new Map(pages.map((page) => [page.route, page]));
  const problems: string[] = [];
  for (const page of pages) {
    for (const href of page.links) {
      if (href === '' || href === '#') {
        problems.push(`${page.route} -> empty link target`);
        continue;
      }
      const [path, fragment] = splitFragment(href);
      const targetRoute = path === ''
        ? page.route
        : posix.normalize(posix.join(posix.dirname(`/${page.route}`), path)).replace(/^\//u, '');
      const target = byRoute.get(targetRoute);
      if (target === undefined) {
        problems.push(`${page.route} -> ${href} (no such page)`);
        continue;
      }
      if (fragment !== '' && !target.anchors.has(fragment)) {
        problems.push(`${page.route} -> ${href} (no such anchor)`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Unresolved internal links:\n  ${problems.join('\n  ')}`);
  }
}

function searchIndexFor(pages: readonly RenderedPage[]): readonly SearchDocument[] {
  return pages.map((page) => ({
    route: page.route,
    title: page.title,
    section: page.section,
    headings: page.headings,
    text: page.text,
  }));
}

/* ------------------------------------------------------- output directory */

/**
 * The generator owns its output directory, and a rebuild must never turn into
 * an arbitrary recursive delete. A directory is only reused when it carries the
 * marker below, and then only the files that marker records are removed.
 */
export const OUTPUT_MARKER = '.interleaf-wiki-site.json';
const MARKER_GENERATOR = 'interleaf-wiki-site';
const MARKER_VERSION = 1;
/** Shape of a path the generator is allowed to write, and therefore replace. */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
/** Project directories that must never be used, or cleared, as build output. */
const PROTECTED_PROJECT_DIRS = [
  '.git', '.agents', '.codex', '.worktrees', 'docs', 'node_modules', 'scripts', 'src', 'tests', 'wiki-site',
];

export type OutputMarker = {
  readonly generator: string;
  readonly version: number;
  readonly generatedAt: string;
  readonly files: readonly string[];
};

export type PreparedOutput = {
  /** Canonical directory the site is written to. */
  readonly outDir: string;
  /** True when a previous generated site was cleared from it. */
  readonly reused: boolean;
};

/** One validated path inside the output directory. */
type OutputTarget = {
  readonly path: string;
  readonly exists: boolean;
};

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

/** Canonical containment: `child` is `parent` itself or sits underneath it. */
function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function assertUnprotectedOutput(outDir: string, projectRoot: string): void {
  if (isFilesystemRoot(outDir)) {
    throw new Error(`Refusing to build into a filesystem root: ${outDir}`);
  }
  if (isSameOrInside(outDir, projectRoot)) {
    throw new Error(`Refusing to build into the project root or one of its parents: ${outDir}`);
  }
  for (const name of PROTECTED_PROJECT_DIRS) {
    const directory = join(projectRoot, name);
    if (isSameOrInside(outDir, directory) || isSameOrInside(directory, outDir)) {
      throw new Error(`Refusing to build into a protected project directory: ${outDir}`);
    }
  }
}

/**
 * Resolves the requested directory and rejects any path that traverses a
 * symbolic link, so the returned path is canonical: writing or deleting under
 * it cannot escape into another tree through a swapped-in link.
 */
async function canonicalOutputPath(target: string): Promise<string> {
  const absolute = resolve(target);
  const segments: string[] = [];
  let current = absolute;
  while (!isFilesystemRoot(current)) {
    segments.unshift(basename(current));
    current = dirname(current);
  }
  let walked = current;
  for (const segment of segments) {
    walked = join(walked, segment);
    const info = await statOrNull(walked);
    if (info?.isSymbolicLink() === true) {
      throw new Error(`Refusing to build through a symbolic link: ${walked}`);
    }
  }
  return absolute;
}

function parseMarker(value: PortableMember): OutputMarker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { generator, version, generatedAt, files } = value as PortableRecord;
  if (generator !== MARKER_GENERATOR || version !== MARKER_VERSION) return null;
  if (typeof generatedAt !== 'string' || !Array.isArray(files)) return null;
  const safe: string[] = [];
  for (const entry of files as readonly PortableValue[]) {
    if (typeof entry !== 'string' || !SAFE_RELATIVE_PATH.test(entry)) return null;
    safe.push(entry);
  }
  return { generator: MARKER_GENERATOR, version: MARKER_VERSION, generatedAt, files: safe };
}

/** Reads the ownership marker; an unreadable or wrong-shaped one is fatal. */
async function readOutputMarker(outDir: string): Promise<OutputMarker | null> {
  const file = join(outDir, OUTPUT_MARKER);
  const info = await statOrNull(file);
  if (info === null) return null;
  if (!info.isFile()) {
    throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} is not a regular file`);
  }
  const raw = await readFile(file, 'utf8');
  let parsed: PortableValue = null;
  try {
    parsed = JSON.parse(raw) as PortableValue;
  } catch {
    throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} is not valid JSON`);
  }
  const marker = parseMarker(parsed);
  if (marker === null) {
    throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} is not a site this generator wrote`);
  }
  return marker;
}

/**
 * The single path check used by everything that deletes or writes: the shape is
 * rejected unless it is a plain relative path, every directory between `outDir`
 * and the file must already be a real directory rather than a link, and an
 * existing target must be a regular file. Checking the parents matters as much
 * as the file: a generated subdirectory (`assets/`, `formats/`) swapped for a
 * symbolic link would otherwise send a delete or a write into another tree.
 */
async function resolveOutputFile(outDir: string, relativePath: string): Promise<OutputTarget> {
  // The marker is the one generated name that starts with a dot.
  if (relativePath !== OUTPUT_MARKER && !SAFE_RELATIVE_PATH.test(relativePath)) {
    throw new Error(`Refusing to use an unsafe output path: ${relativePath}`);
  }
  const segments = relativePath.split('/');
  let directory = outDir;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    const info = await statOrNull(directory);
    // Nothing exists below a directory that does not exist yet.
    if (info === null) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to use ${directory}: it is not a plain directory`);
    }
  }
  const path = join(outDir, ...segments);
  if (path === outDir || !isSameOrInside(outDir, path)) {
    throw new Error(`Refusing to use a path outside the output directory: ${path}`);
  }
  const info = await statOrNull(path);
  if (info === null) return { path, exists: false };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing to use ${path}: it is not a regular file`);
  }
  return { path, exists: true };
}

/**
 * Validates the complete set of paths a build would touch — everything the
 * marker records plus every file this build intends to write, the bundler's
 * `assets/wiki.js` included — and returns the files to delete. Nothing is
 * removed until the whole plan is known to be safe, so a bad entry late in a
 * marker cannot leave a half-cleared directory behind.
 */
async function planOutputFiles(
  outDir: string,
  marker: OutputMarker | null,
  writes: readonly string[],
): Promise<readonly string[]> {
  const owned = new Set(marker === null ? [] : [...marker.files, OUTPUT_MARKER]);
  const remove: string[] = [];
  for (const entry of owned) {
    const target = await resolveOutputFile(outDir, entry);
    if (target.exists) remove.push(target.path);
  }
  for (const entry of writes) {
    const target = await resolveOutputFile(outDir, entry);
    if (target.exists && !owned.has(entry)) {
      throw new Error(`Refusing to overwrite ${target.path}: this generator did not write it`);
    }
  }
  return remove;
}

/** Deletes exactly the planned files, then the folders left empty by them. */
async function removePlannedFiles(outDir: string, files: readonly string[]): Promise<void> {
  const directories = new Set<string>();
  for (const file of files) {
    const info = await statOrNull(file);
    // Re-checked immediately before the delete: anything that changed since the
    // plan was made is no longer a file this generator may remove.
    if (info === null || info.isSymbolicLink() || !info.isFile()) continue;
    await unlink(file);
    for (let parent = dirname(file); parent !== outDir && isSameOrInside(outDir, parent); parent = dirname(parent)) {
      directories.add(parent);
    }
  }
  // Deepest first, and only when empty: `rmdir` fails on anything else.
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch {
      // A directory the user added files to stays exactly as it is.
    }
  }
}

/**
 * Validates the requested output directory and leaves it ready to be written:
 * created when missing, cleared of exactly its own files when this generator
 * owns it, and refused — without deleting anything — in every other case.
 * `writes` lists the relative paths the build will produce, so a destination
 * that is a link, a directory, or somebody else's file is refused up front.
 */
export async function prepareOutputDirectory(
  target: string,
  projectRoot: string,
  writes: readonly string[] = [],
): Promise<PreparedOutput> {
  const outDir = await canonicalOutputPath(target);
  assertUnprotectedOutput(outDir, resolve(projectRoot));
  const info = await statOrNull(outDir);
  if (info !== null && !info.isDirectory()) {
    throw new Error(`Refusing to build into ${outDir}: it exists and is not a directory`);
  }
  const marker = info === null ? null : await readOutputMarker(outDir);
  if (info !== null && marker === null && (await readdir(outDir)).length > 0) {
    throw new Error(
      `Refusing to build into ${outDir}: it is not empty and was not written by this generator. `
      + 'Choose an empty directory, or the directory of a previous build.',
    );
  }
  const remove = await planOutputFiles(outDir, marker, writes);
  if (info === null) await mkdir(outDir, { recursive: true });
  await removePlannedFiles(outDir, remove);
  return { outDir, reused: marker !== null };
}

/** Creates the directories for a generated file, refusing to follow links. */
async function ensureSafeDirectory(outDir: string, directory: string): Promise<void> {
  const rel = relative(outDir, directory);
  if (rel === '') return;
  let current = outDir;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const info = await statOrNull(current);
    if (info === null) {
      await mkdir(current);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to write through ${current}: it is not a plain directory`);
    }
  }
}

/** Writes one generated file, through the same check the plan used. */
async function writeSiteFile(outDir: string, relativePath: string, contents: string | Uint8Array): Promise<void> {
  const { path } = await resolveOutputFile(outDir, relativePath);
  await ensureSafeDirectory(outDir, dirname(path));
  await writeFile(path, contents, 'utf8');
}

async function bundleClient(projectRoot: string, outDir: string): Promise<void> {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: projectRoot,
    build: {
      outDir: join(outDir, 'assets'),
      emptyOutDir: false,
      target: 'es2020',
      lib: {
        entry: join(projectRoot, 'wiki.client.ts'),
        formats: ['iife'],
        name: 'InterleafWiki',
        fileName: () => 'wiki.js',
      },
    },
  });
}

/** Renders the whole site into `options.outDir`. */
export async function buildSite(options: BuildOptions): Promise<BuildResult> {
  const docsRoot = join(options.projectRoot, 'docs');
  await assertAllWikiPagesIncluded(docsRoot);
  const refs = sitePageRefs();
  const routes = new Map(refs.map((ref) => [ref.source, ref.route]));

  const navModel = { order: [routeForSource(HOME_SOURCE)], section: new Map<string, string>(), parents: new Map<string, string>() };
  for (const section of NAVIGATION) collectNavItems(section.items, undefined, navModel, section.title);

  const pages: RenderedPage[] = [];
  for (const ref of refs) {
    pages.push(await renderPage(ref, docsRoot, routes, navModel.section.get(ref.route) ?? 'Wiki'));
  }
  assertLinksResolve(pages);

  const model: SiteModel = {
    pages,
    order: navModel.order,
    sections: navModel.section,
    parents: navModel.parents,
    byRoute: new Map(pages.map((page) => [page.route, page])),
  };

  // Every path this build will produce, checked before anything is removed or
  // written — `assets/wiki.js` included, because Vite writes it and would
  // happily follow a symbolic link left in its place.
  // Screenshots are read and verified before the output directory is touched,
  // so a bad image fails the build without clearing the previous site.
  const imageNames = [...new Set(pages.flatMap((page) => page.images))].sort();
  const screenshots = new Map<string, Buffer>();
  for (const name of imageNames) {
    screenshots.set(`${IMAGE_OUTPUT_DIR}/${name}`, await readWikiImage(options.projectRoot, name));
  }
  const assets = ['assets/wiki.css', 'assets/search-index.js', 'assets/wiki.js', ...screenshots.keys()];
  const writes = [...pages.map((page) => page.route), ...assets, OUTPUT_MARKER];

  const { outDir } = await prepareOutputDirectory(options.outDir, options.projectRoot, writes);
  await ensureSafeDirectory(outDir, join(outDir, 'assets'));
  for (const page of pages) {
    await writeSiteFile(outDir, page.route, renderPageHtml(page, model));
  }

  const styles = await readFile(join(options.projectRoot, 'wiki-site', 'styles.css'), 'utf8');
  await writeSiteFile(outDir, 'assets/wiki.css', styles);
  const index = { generated: pages.length, documents: searchIndexFor(pages) };
  await writeSiteFile(
    outDir,
    'assets/search-index.js',
    `window.__INTERLEAF_WIKI_INDEX__ = ${embeddableJson(index)};\n`,
  );
  for (const [path, bytes] of screenshots) await writeSiteFile(outDir, path, bytes);
  if (options.bundleClient !== false) await bundleClient(options.projectRoot, outDir);

  // Written last: the marker states exactly what a later build may remove.
  const marker: OutputMarker = {
    generator: MARKER_GENERATOR,
    version: MARKER_VERSION,
    generatedAt: new Date().toISOString(),
    files: [...pages.map((page) => page.route), ...assets],
  };
  await writeSiteFile(outDir, OUTPUT_MARKER, `${JSON.stringify(marker, null, 2)}\n`);

  return { pages, assets };
}

/** `--out <directory>` overrides the default `out/wiki` output location. */
export function outDirFromArgv(argv: readonly string[], projectRoot: string): string {
  const flag = argv.indexOf('--out');
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined || value === '') return join(projectRoot, 'out', 'wiki');
  return resolve(projectRoot, value);
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const outDir = outDirFromArgv(process.argv.slice(2), projectRoot);
  const result = await buildSite({ projectRoot, outDir });
  const inside = relative(projectRoot, outDir);
  const where = inside === '' || inside.startsWith('..') ? outDir : `.${sep}${inside}`;
  process.stdout.write(`Interleaf wiki: ${String(result.pages.length)} pages written to ${where}\n`);
  process.stdout.write(`Preview with: python3 -m http.server --directory ${where} 4173\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
