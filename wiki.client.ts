/**
 * Browser behaviour for the generated wiki website: search, the collapsible
 * mobile navigation, and highlighting the section currently on screen.
 *
 * The site works without this script — every page, link and anchor is static
 * HTML — so nothing here is required to read the documentation.
 */
import { searchDocuments, type SearchDocument, type SearchHit } from './wiki.search';

type WikiIndex = {
  readonly documents: readonly SearchDocument[];
};

type IndexHost = typeof globalThis & {
  readonly __INTERLEAF_WIKI_INDEX__?: WikiIndex;
};

const SAFE_ROUTE = /^[a-z0-9][a-z0-9/_-]*\.html$/u;
const SAFE_ANCHOR = /^[\p{L}\p{N}_-]+$/u;
const SEARCH_DEBOUNCE_MS = 120;

function readIndex(): readonly SearchDocument[] {
  const host: IndexHost = globalThis;
  const index = host.__INTERLEAF_WIKI_INDEX__;
  return index === undefined ? [] : index.documents;
}

function basePrefix(): string {
  return document.documentElement.getAttribute('data-base') ?? '';
}

/** Only routes this build generated become links. */
function hitHref(hit: SearchHit): string | null {
  if (!SAFE_ROUTE.test(hit.route)) return null;
  const anchor = hit.anchor !== null && SAFE_ANCHOR.test(hit.anchor) ? `#${hit.anchor}` : '';
  return `${basePrefix()}${hit.route}${anchor}`;
}

function renderSnippet(hit: SearchHit): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  paragraph.className = 'search-snippet';
  for (const segment of hit.snippet) {
    if (segment.match) {
      const mark = document.createElement('mark');
      mark.textContent = segment.text;
      paragraph.append(mark);
    } else {
      paragraph.append(document.createTextNode(segment.text));
    }
  }
  return paragraph;
}

function renderHit(hit: SearchHit): HTMLLIElement | null {
  const href = hitHref(hit);
  if (href === null) return null;
  const item = document.createElement('li');
  item.className = 'search-item';
  const link = document.createElement('a');
  link.className = 'search-link';
  link.setAttribute('href', href);
  const title = document.createElement('span');
  title.className = 'search-title';
  title.textContent = hit.title;
  const context = document.createElement('span');
  context.className = 'search-context';
  context.textContent = hit.headingText === null ? hit.section : `${hit.section} · ${hit.headingText}`;
  link.append(title, context);
  item.append(link, renderSnippet(hit));
  return item;
}

type SearchElements = {
  readonly input: HTMLInputElement;
  readonly results: HTMLElement;
  readonly status: HTMLElement;
  readonly list: HTMLElement;
};

function findSearchElements(): SearchElements | null {
  const input = document.querySelector('#wiki-search');
  const results = document.querySelector('#search-results');
  if (!(input instanceof HTMLInputElement) || !(results instanceof HTMLElement)) return null;
  const status = results.querySelector('.search-status');
  const list = results.querySelector('.search-list');
  if (!(status instanceof HTMLElement) || !(list instanceof HTMLElement)) return null;
  return { input, results, status, list };
}

function closeResults(elements: SearchElements): void {
  elements.results.hidden = true;
  elements.input.setAttribute('aria-expanded', 'false');
}

function describe(count: number, query: string): string {
  if (count === 0) return `No results for “${query}”. Try a shorter word, or browse the navigation.`;
  return count === 1 ? '1 result' : `${String(count)} results`;
}

function runSearch(elements: SearchElements, documents: readonly SearchDocument[]): void {
  const query = elements.input.value.trim();
  elements.list.replaceChildren();
  if (query === '') {
    closeResults(elements);
    elements.status.textContent = '';
    return;
  }
  const hits = searchDocuments(documents, query);
  for (const hit of hits) {
    const item = renderHit(hit);
    if (item !== null) elements.list.append(item);
  }
  elements.status.textContent = describe(elements.list.childElementCount, query);
  elements.results.hidden = false;
  elements.input.setAttribute('aria-expanded', 'true');
}

function resultLinks(elements: SearchElements): readonly HTMLAnchorElement[] {
  return [...elements.list.querySelectorAll('a.search-link')].filter(
    (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
  );
}

function moveFocus(elements: SearchElements, delta: number): void {
  const links = resultLinks(elements);
  if (links.length === 0) return;
  const active = document.activeElement;
  const current = links.findIndex((link) => link === active);
  const next = current === -1 ? (delta > 0 ? 0 : links.length - 1) : current + delta;
  if (next < 0) {
    elements.input.focus();
    return;
  }
  links[Math.min(next, links.length - 1)]?.focus();
}

function onSearchKeydown(event: KeyboardEvent, elements: SearchElements): void {
  if (event.key === 'Escape') {
    closeResults(elements);
    elements.input.focus();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(elements, 1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(elements, -1);
  }
}

function setUpSearch(): void {
  const elements = findSearchElements();
  if (elements === null) return;
  const documents = readIndex();
  let timer = 0;
  elements.input.addEventListener('input', () => {
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      runSearch(elements, documents);
    }, SEARCH_DEBOUNCE_MS);
  });
  elements.input.addEventListener('focus', () => {
    if (elements.input.value.trim() !== '') runSearch(elements, documents);
  });
  const container = elements.input.closest('.search');
  container?.addEventListener('keydown', (event: Event) => {
    if (event instanceof KeyboardEvent) onSearchKeydown(event, elements);
  });
  const form = elements.input.closest('form');
  form?.addEventListener('submit', (event: Event) => {
    event.preventDefault();
    runSearch(elements, documents);
  });
  document.addEventListener('click', (event: Event) => {
    const target = event.target;
    if (target instanceof Node && container?.contains(target) === true) return;
    closeResults(elements);
  });
}

function setUpNavigation(): void {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('#site-nav');
  if (!(toggle instanceof HTMLButtonElement) || !(nav instanceof HTMLElement)) return;
  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('nav-open', open);
  };
  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  nav.addEventListener('click', (event: Event) => {
    if (event.target instanceof HTMLAnchorElement) setOpen(false);
  });
  document.addEventListener('keydown', (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    // Closing the menu removes whatever had focus inside it from the page, so
    // hand focus back to the control that opened it.
    const active = document.activeElement;
    const insideMenu = active instanceof Node && nav.contains(active);
    setOpen(false);
    if (insideMenu || active === toggle) toggle.focus();
  });
}

/** Marks the contents entry for the section currently in view. */
function setUpSectionHighlight(): void {
  const links = [...document.querySelectorAll('.toc-list a')].filter(
    (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
  );
  if (links.length === 0 || typeof IntersectionObserver === 'undefined') return;
  const byId = new Map<string, HTMLAnchorElement>();
  for (const link of links) {
    const id = link.getAttribute('href')?.slice(1);
    if (id !== undefined && id !== '') byId.set(id, link);
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const link = byId.get(entry.target.id);
        if (link === undefined) continue;
        for (const other of links) other.classList.remove('is-active');
        link.classList.add('is-active');
      }
    },
    { rootMargin: '0px 0px -70% 0px', threshold: 0 },
  );
  for (const id of byId.keys()) {
    const heading = document.getElementById(id);
    if (heading !== null) observer.observe(heading);
  }
}

function start(): void {
  document.documentElement.classList.remove('no-js');
  document.documentElement.classList.add('js');
  setUpNavigation();
  setUpSearch();
  setUpSectionHighlight();
}

start();
