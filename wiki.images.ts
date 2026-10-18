/**
 * Local screenshots for the Interleaf wiki.
 *
 * A wiki page may show an image only when it is one of the product screenshots
 * the website already publishes from `website/assets/screens/`. The Markdown
 * refers to that file with a plain relative path, so the same page also renders
 * in a repository browser, and the build copies the exact file into the site.
 * Remote images, other directories, links, and anything that is not a raster
 * image of the expected type fail the build rather than being passed through.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';

/** The one repository directory, relative to the project root, images come from. */
export const IMAGE_SOURCE_DIR = 'website/assets/screens';
/** Where the copies are written, relative to the site root. */
export const IMAGE_OUTPUT_DIR = 'assets/screens';
/** A screenshot larger than this is a mistake, not a page asset. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_NAME = /^[a-z0-9][a-z0-9-]*\.(?:webp|png|jpe?g)$/u;
/**
 * Anything other than a plain relative path: a URI scheme, a protocol-relative
 * or absolute path, a backslash, percent-encoding, a query, a fragment, or
 * whitespace. Each is refused rather than interpreted.
 */
const NOT_PLAIN_PATH = /^[a-z][a-z0-9+.-]*:|^\/|[\\%?#\s]/iu;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** True for a non-empty plain relative path; says nothing about where it points. */
export function isPlainImagePath(src: string): boolean {
  return src !== '' && !NOT_PLAIN_PATH.test(src);
}

/**
 * Maps an image reference in `source` (a `docs/`-relative Markdown path) to the
 * screenshot file name it names, or throws when it names anything else.
 */
export function imageNameFor(src: string, source: string): string {
  if (!isPlainImagePath(src)) {
    throw new Error(`Wiki images must be local screenshots, not ${JSON.stringify(src)} (${source})`);
  }
  const target = posix.normalize(posix.join('docs', posix.dirname(source), src));
  const name = posix.basename(target);
  if (posix.dirname(target) !== IMAGE_SOURCE_DIR || !IMAGE_NAME.test(name)) {
    throw new Error(`Wiki images must come from ${IMAGE_SOURCE_DIR}/, not ${JSON.stringify(src)} (${source})`);
  }
  return name;
}

/** Every image reference in the Markdown, reference-style images included. */
export function imageSources(markdown: string): string[] {
  const engine = new Marked({ gfm: true });
  const found: string[] = [];
  // The callback is synchronous, so the returned (empty) promise list is ignored.
  void engine.walkTokens(engine.lexer(markdown), (token: Token) => {
    if (token.type === 'image') found.push((token as Tokens.Image).href);
  });
  return found;
}

/** Validates a page's images up front: reference -> screenshot file name. */
export function pageImages(markdown: string, source: string): ReadonlyMap<string, string> {
  return new Map(imageSources(markdown).map((src) => [src, imageNameFor(src, source)]));
}

function hasImageSignature(name: string, bytes: Buffer): boolean {
  const extension = posix.extname(name);
  if (extension === '.png') return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (extension === '.webp') {
    return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  }
  return bytes.subarray(0, 3).equals(JPEG_SIGNATURE);
}

/**
 * Reads one allowlisted screenshot. Every directory on the way must be a real
 * directory, and the file is opened without following a link, so a swapped-in
 * symbolic link cannot pull another file into the published site.
 */
export async function readWikiImage(projectRoot: string, name: string): Promise<Buffer> {
  if (!IMAGE_NAME.test(name)) throw new Error(`Refusing an unsafe wiki image name: ${name}`);
  let directory = projectRoot;
  for (const segment of IMAGE_SOURCE_DIR.split('/')) {
    directory = join(directory, segment);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to read wiki images through ${directory}: it is not a plain directory`);
    }
  }
  const path = join(directory, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Refusing wiki image ${path}: not a regular file under ${String(MAX_IMAGE_BYTES)} bytes`);
    }
    const bytes = await handle.readFile();
    if (!hasImageSignature(name, bytes)) throw new Error(`Refusing wiki image ${path}: contents do not match its type`);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Defence in depth for rendered Markdown: an image that is not a plain local path is removed. */
export function dropNonLocalImages(root: Element): void {
  for (const image of root.querySelectorAll('img')) {
    if (!isPlainImagePath(image.getAttribute('src') ?? '')) image.remove();
  }
}

function isCaption(node: ChildNode): boolean {
  return node.nodeType === 1 && (node as Element).tagName === 'EM';
}

/** A paragraph holding only the image, and optionally an italic caption, becomes a figure. */
function captionFigure(image: Element, document: Document): void {
  const paragraph = image.parentElement;
  if (paragraph?.tagName !== 'P') return;
  const others = [...paragraph.childNodes].filter((node) => node !== image && (node.textContent ?? '').trim() !== '');
  const caption = others[0];
  if (others.length > 1 || (caption !== undefined && !isCaption(caption))) return;
  const figure = document.createElement('figure');
  figure.className = 'wiki-figure';
  figure.append(image);
  if (caption !== undefined) {
    const figcaption = document.createElement('figcaption');
    figcaption.append(...caption.childNodes);
    figure.append(figcaption);
  }
  paragraph.replaceWith(figure);
}

/**
 * Points each validated image at its copy in the site and removes any other
 * image. `hrefFor` turns a file name into a link relative to the current page.
 */
export function placeImages(
  body: Element,
  document: Document,
  images: ReadonlyMap<string, string>,
  hrefFor: (name: string) => string,
): void {
  for (const image of body.querySelectorAll('img')) {
    const name = images.get(image.getAttribute('src') ?? '');
    if (name === undefined) {
      image.remove();
      continue;
    }
    image.setAttribute('src', hrefFor(name));
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    captionFigure(image, document);
  }
}
