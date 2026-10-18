/**
 * Progressive enhancement for the Interleaf marketing site: scroll reveals,
 * a section indicator in the header, and an in-page screenshot viewer.
 *
 * The page is complete without this script. Every screenshot is an ordinary
 * link to its full-size file, reveals are only armed once the observer that
 * undoes them exists, and nothing here moves the scroll position.
 */

const REVEAL_STAGGER_MS = 60;
const REVEAL_MAX_STAGGER = 2;
/** Sections the header links to, in page order. */
const SPY_SECTIONS = ['features', 'local-first', 'providers'] as const;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Reveals `[data-reveal]` blocks as they approach the viewport. */
export function setupReveals(root: Document): void {
  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return;
  const targets = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (targets.length === 0) return;

  // Siblings that enter together cascade slightly instead of arriving at once.
  for (const target of targets) {
    const parent = target.parentElement;
    if (parent === null) continue;
    const siblings = [...parent.children].filter((child) => child.hasAttribute('data-reveal'));
    const index = Math.min(siblings.indexOf(target), REVEAL_MAX_STAGGER);
    if (index > 0) target.style.setProperty('--reveal-delay', `${String(index * REVEAL_STAGGER_MS)}ms`);
  }

  const reveal = (target: Element): void => {
    target.classList.add('is-revealed');
  };
  // Reveal as soon as a block's top edge is just inside the viewport, so tall
  // screenshots never sit blank while the reader scrolls onto them.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -4% 0px', threshold: 0 },
  );
  for (const target of targets) observer.observe(target);
  root.documentElement.classList.add('js-reveal');

  // Printing, or the browser's find-in-page jumping ahead, must never meet an
  // invisible block.
  const revealAll = (): void => {
    for (const target of targets) reveal(target);
    observer.disconnect();
  };
  window.addEventListener('beforeprint', revealAll);
  window.addEventListener('hashchange', revealAll, { once: true });
}

/** Marks the header link for the section currently under the header. */
export function setupScrollSpy(root: Document): void {
  if (typeof IntersectionObserver === 'undefined') return;
  const links = new Map<string, HTMLAnchorElement>();
  for (const id of SPY_SECTIONS) {
    const link = root.querySelector<HTMLAnchorElement>(`.site-nav a[href="#${id}"]`);
    if (link !== null) links.set(id, link);
  }
  const visible = new Set<string>();
  const update = (): void => {
    const current = SPY_SECTIONS.find((id) => visible.has(id));
    for (const [id, link] of links) {
      if (id === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      update();
    },
    // A thin band a little below the header decides which section is "current".
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const id of SPY_SECTIONS) {
    const section = root.getElementById(id);
    if (section !== null) observer.observe(section);
  }
}

/**
 * Opens screenshot links in a modal `<dialog>`. Modified clicks (new tab,
 * download) and browsers without `showModal` keep the plain link behaviour.
 */
export function setupLightbox(root: Document): void {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]')];
  if (links.length === 0 || typeof HTMLDialogElement === 'undefined') return;

  const dialog = root.createElement('dialog');
  dialog.className = 'lightbox';
  dialog.setAttribute('aria-label', 'Screenshot');
  const close = root.createElement('button');
  close.type = 'button';
  close.className = 'lightbox__close';
  close.textContent = 'Close';
  const image = root.createElement('img');
  image.decoding = 'async';
  const caption = root.createElement('p');
  caption.className = 'lightbox__caption';
  dialog.append(close, image, caption);
  root.body.append(dialog);

  let opener: HTMLElement | null = null;
  close.addEventListener('click', () => {
    dialog.close();
  });
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    opener?.focus();
    opener = null;
  });

  for (const link of links) {
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const thumbnail = link.querySelector('img');
      image.src = link.href;
      image.alt = thumbnail?.alt ?? '';
      caption.textContent = link.closest('figure')?.querySelector('figcaption')?.textContent ?? '';
      opener = link;
      dialog.showModal();
      close.focus();
    });
  }
}

function start(): void {
  setupReveals(document);
  setupScrollSpy(document);
  setupLightbox(document);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
