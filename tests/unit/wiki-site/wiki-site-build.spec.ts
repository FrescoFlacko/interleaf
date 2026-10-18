import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { buildSite, type BuildResult } from '../../../wiki.build';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Every Markdown file under `docs/wiki/`, as a `docs/`-relative path. */
async function wikiSources(dir = 'wiki'): Promise<string[]> {
  const entries = await readdir(join(projectRoot, 'docs', dir), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await wikiSources(child)));
    else if (entry.name.endsWith('.md')) found.push(child);
  }
  return found;
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

let outDir = '';
let result: BuildResult;
type SiteDocument = ReturnType<typeof parseHTML>['document'];
const documents = new Map<string, SiteDocument>();

beforeAll(async () => {
  // `realpath` because the generator refuses output paths that cross a symlink,
  // and macOS exposes the temporary directory through one.
  outDir = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-wiki-')));
  result = await buildSite({ projectRoot, outDir, bundleClient: false });
  for (const route of await htmlFiles(outDir)) {
    const html = await readFile(join(outDir, ...route.split('/')), 'utf8');
    documents.set(route, parseHTML(html).document);
  }
}, 120_000);

afterAll(async () => {
  if (outDir !== '') await rm(outDir, { recursive: true, force: true });
});

describe('wiki site build', () => {
  it('renders every wiki Markdown page as an HTML page', async () => {
    const sources = await wikiSources();
    expect(sources).toHaveLength(28);
    const rendered = new Set(result.pages.map((page) => page.source));
    for (const source of sources) expect(rendered.has(source)).toBe(true);
    expect(documents.size).toBe(result.pages.length);
  });

  it('writes the stylesheet and search index next to the pages', async () => {
    const css = await readFile(join(outDir, 'assets', 'wiki.css'), 'utf8');
    expect(css).toContain('.article');
    const index = await readFile(join(outDir, 'assets', 'search-index.js'), 'utf8');
    expect(index.startsWith('window.__INTERLEAF_WIKI_INDEX__ = {')).toBe(true);
    expect(index).not.toContain('</script');
  });

  it('gives every page the documentation chrome', () => {
    for (const [route, document] of documents) {
      expect(document.querySelector('.skip-link'), route).not.toBeNull();
      expect(document.querySelector('nav.breadcrumb'), route).not.toBeNull();
      expect(document.querySelector('nav.sidebar'), route).not.toBeNull();
      expect(document.querySelector('main#main'), route).not.toBeNull();
      expect(document.querySelector('h1.article-title')?.textContent ?? '', route).not.toBe('');
      expect(document.querySelectorAll('h1'), route).toHaveLength(1);
      expect(document.documentElement.getAttribute('lang'), route).toBe('en');
    }
  });

  it('marks the current page in the navigation of every non-home page', () => {
    for (const [route, document] of documents) {
      const current = document.querySelectorAll('.sidebar [aria-current="page"]');
      expect(current.length, route).toBe(1);
    }
  });

  it('links previous and next pages through the whole site', () => {
    const home = documents.get('index.html');
    expect(home?.querySelector('.pager-next')).not.toBeNull();
    const last = documents.get('project/packaging.html');
    expect(last?.querySelector('.pager-prev')).not.toBeNull();
    expect(last?.querySelector('.pager-next')).toBeNull();
  });

  it('offers an on-page contents list for long pages', () => {
    const providers = documents.get('ai-providers.html');
    const entries = providers?.querySelectorAll('.toc-list a') ?? [];
    expect(entries.length).toBeGreaterThan(2);
    for (const entry of entries) {
      const id = entry.getAttribute('href')?.slice(1) ?? '';
      expect(providers?.getElementById(id), id).not.toBeNull();
    }
  });

  it('resolves every internal link to a real page and anchor', () => {
    const problems: string[] = [];
    for (const [route, document] of documents) {
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href') ?? '';
        if (href === '' || /^(?:https?:|mailto:)/u.test(href)) {
          if (href === '') problems.push(`${route}: empty href`);
          continue;
        }
        const [path = '', fragment = ''] = href.split('#');
        const target = path === ''
          ? route
          : posix.normalize(posix.join(posix.dirname(`/${route}`), path)).replace(/^\//u, '');
        const targetDocument = documents.get(target);
        if (targetDocument === undefined) {
          problems.push(`${route} -> ${href} (missing page)`);
          continue;
        }
        if (fragment !== '' && targetDocument.getElementById(fragment) === null) {
          problems.push(`${route} -> ${href} (missing anchor)`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('leaves no Markdown targets or repository paths in the output', () => {
    for (const [route, document] of documents) {
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href') ?? '';
        expect(href.endsWith('.md'), `${route} ${href}`).toBe(false);
        expect(href.startsWith('/Users'), `${route} ${href}`).toBe(false);
        expect(href.startsWith('file:'), `${route} ${href}`).toBe(false);
      }
    }
  });

  it('opens external links safely and keeps script URLs out of the site', () => {
    for (const [route, document] of documents) {
      for (const anchor of document.querySelectorAll('a[href^="http"]')) {
        expect(anchor.getAttribute('rel'), route).toContain('noopener');
      }
      for (const element of document.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          expect(attribute.name.startsWith('on'), `${route} ${attribute.name}`).toBe(false);
          expect(/^\s*(?:javascript|data|vbscript):/iu.test(attribute.value), `${route} ${attribute.value}`)
            .toBe(false);
        }
      }
      const scripts = [...document.querySelectorAll('script')];
      expect(scripts.map((script) => script.getAttribute('src')), route).toEqual([
        expect.stringContaining('assets/search-index.js'),
        expect.stringContaining('assets/wiki.js'),
      ]);
      for (const script of scripts) expect(script.textContent, route).toBe('');
    }
  });

  it('references assets relatively so the site can be hosted in a subdirectory', () => {
    const nested = documents.get('formats/pdf.html');
    expect(nested?.querySelector('link[rel="stylesheet"]')?.getAttribute('href'))
      .toBe('../assets/wiki.css');
    expect(nested?.documentElement.getAttribute('data-base')).toBe('../');
    for (const [route, document] of documents) {
      for (const element of document.querySelectorAll('[href], [src]')) {
        const value = element.getAttribute('href') ?? element.getAttribute('src') ?? '';
        expect(value.startsWith('/'), `${route} ${value}`).toBe(false);
      }
    }
  });

  it('makes wide tables and code blocks reachable from the keyboard', () => {
    const providers = documents.get('ai-providers.html');
    const table = providers?.querySelector('.table-scroll');
    expect(table?.getAttribute('tabindex')).toBe('0');
    expect(table?.getAttribute('role')).toBe('region');
    expect(table?.getAttribute('aria-label')).not.toBeNull();
    const code = documents.get('quick-start.html')?.querySelector('pre');
    expect(code?.getAttribute('tabindex')).toBe('0');
    expect(code?.getAttribute('data-language')).toBe('bash');
  });

  it('replaces the hand-written breadcrumb and contents block with site chrome', () => {
    const page = documents.get('quick-start.html');
    const article = page?.querySelector('.article')?.textContent ?? '';
    expect(article).not.toContain('›');
    expect(article).not.toContain('On this page');
    expect(page?.querySelector('.breadcrumb')?.textContent).toContain('Interleaf Wiki');
  });
});
