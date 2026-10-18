/**
 * The reader's half of diagram support for fenced `mermaid` blocks.
 *
 * Two rules shape everything here.
 *
 * The first is that a diagram is an illustration added beside the block, never
 * a replacement for it. The original `<pre>` stays in the document, visible,
 * carrying the same `.markdown-block-content` span it always did, so block
 * indexes, character offsets, text extraction, search, citations, and stored
 * annotation anchors all continue to mean exactly what they meant before a
 * picture appeared. Hiding the source would have been tidier and would have
 * silently moved every anchor in the document.
 *
 * The second is that the picture is displayed as an image. Main returns markup
 * that has already been rebuilt from an allow-list and re-scanned, and this
 * side still never inserts it into the reader's DOM: it becomes the `src` of an
 * `<img>`, a context where script does not run, external references are not
 * fetched, and the surrounding document cannot be reached.
 */
import { MERMAID_LIMITS } from '@shared/schemas/mermaid';
import type { MermaidAppearance, MermaidRenderSuccess } from '@shared/types/mermaid';

export const MERMAID_LANGUAGE = 'mermaid';

/**
 * Friendly names for the diagram keywords a source can open with, used for the
 * accessible label. An unrecognized keyword is simply "diagram" — the list is
 * for wording, never for deciding what may be drawn.
 */
const DIAGRAM_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^flowchart\b|^graph\b/iu, 'Flowchart'],
  [/^sequencediagram\b/iu, 'Sequence diagram'],
  [/^classdiagram\b/iu, 'Class diagram'],
  [/^statediagram(?:-v2)?\b/iu, 'State diagram'],
  [/^erdiagram\b/iu, 'Entity relationship diagram'],
  [/^journey\b/iu, 'User journey diagram'],
  [/^gantt\b/iu, 'Gantt chart'],
  [/^pie\b/iu, 'Pie chart'],
  [/^mindmap\b/iu, 'Mind map'],
  [/^timeline\b/iu, 'Timeline'],
  [/^gitgraph\b/iu, 'Git graph'],
];

/**
 * Names the diagram for anyone who cannot see it.
 *
 * The keyword comes from the source, so it is bounded to one short word and
 * matched against the list above rather than echoed: document text is not put
 * into a label verbatim.
 */
export function describeDiagramKind(source: string): string {
  const firstLine = source.split('\n').find((line) => line.trim().length > 0) ?? '';
  const keyword = firstLine.trim();
  for (const [pattern, name] of DIAGRAM_KINDS) {
    if (pattern.test(keyword)) return name;
  }
  return 'Diagram';
}

export type MermaidFigure = {
  /** The block element: one `[data-markdown-block]`, exactly as before. */
  readonly figure: HTMLElement;
  /** The scrollable box the picture is painted into. */
  readonly region: HTMLElement;
  /** The line that explains an undrawn diagram. */
  readonly note: HTMLElement;
};

/**
 * Wraps a fenced source in the structure a diagram is painted into.
 *
 * `data-markdown-block` moves to the figure and is not repeated on the `<pre>`,
 * so the document still has exactly one element per block and every existing
 * query, `closest()` walk, and anchor lookup finds the same single answer.
 */
export function createMermaidFigure(blockIndex: number, pre: HTMLElement): MermaidFigure {
  const figure = document.createElement('figure');
  figure.setAttribute('data-markdown-block', String(blockIndex));
  figure.setAttribute('data-testid', `markdown-mermaid-${String(blockIndex)}`);
  figure.className = 'markdown-mermaid my-4';

  const region = document.createElement('div');
  region.className = 'markdown-mermaid-diagram';
  region.setAttribute('data-testid', `markdown-mermaid-diagram-${String(blockIndex)}`);
  region.setAttribute('aria-busy', 'true');

  const note = document.createElement('p');
  note.className = 'markdown-mermaid-note';
  note.setAttribute('data-testid', `markdown-mermaid-note-${String(blockIndex)}`);
  note.hidden = true;

  pre.removeAttribute('data-markdown-block');
  figure.append(region, note, pre);
  return { figure, region, note };
}

/**
 * Puts a drawn diagram on screen as an image.
 *
 * The markup is base64-encoded into a `data:` URL rather than percent-encoded
 * or inlined: an image source is a context with no script, no document access,
 * and no external loading, and base64 carries any byte the drawing contains
 * without a second escaping scheme to get wrong.
 */
export function paintDiagram(
  region: HTMLElement,
  result: MermaidRenderSuccess,
  label: string
): void {
  const image = document.createElement('img');
  image.className = 'markdown-mermaid-image';
  image.decoding = 'async';
  image.width = result.width;
  image.height = result.height;
  image.alt = `${label}. The diagram source is shown below.`;
  image.src = `data:image/svg+xml;base64,${encodeSvgToBase64(result.svg)}`;
  region.replaceChildren(image);
  region.removeAttribute('aria-busy');
}

function encodeSvgToBase64(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Explains an undrawn diagram without taking anything away.
 *
 * The region is emptied and the note is shown above the source that was always
 * there, so the reader ends up with the same fenced block they would have had
 * before diagrams existed, plus one sentence about why there is no picture.
 */
export function showDiagramNote(region: HTMLElement, note: HTMLElement, message: string): void {
  region.replaceChildren();
  region.removeAttribute('aria-busy');
  region.hidden = true;
  note.textContent = message;
  note.hidden = false;
}

/**
 * Gives an oversized diagram the same treatment a wide table gets.
 *
 * A box that scrolls only under a pointer is unreachable from the keyboard, so
 * while — and only while — the picture is actually larger than its box, the
 * region becomes a focusable, named landmark. A diagram that fits is not a tab
 * stop and does not announce scrolling that cannot happen, which means this is
 * a function of layout and is re-evaluated whenever layout changes.
 */
export function syncDiagramScrollAffordance(region: HTMLElement, label: string): void {
  const overflows =
    region.scrollWidth > region.clientWidth || region.scrollHeight > region.clientHeight;
  if (overflows && !region.hidden) {
    region.setAttribute('tabindex', '0');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', `${label}, scrollable`);
    return;
  }
  region.removeAttribute('tabindex');
  region.removeAttribute('role');
  region.removeAttribute('aria-label');
}

/**
 * Decides which appearance a diagram should be drawn for.
 *
 * The answer is taken from the colour the reader is actually painted in rather
 * than from a theme name, because the reader background can be overridden
 * independently of the application theme. Luminance of the nearest opaque
 * background is the one signal that is correct for every combination of the
 * two, including the ones that do not exist yet.
 */
export function detectAppearance(element: Element | null): MermaidAppearance {
  let current: Element | null = element;
  while (current !== null) {
    const colour = parseColour(window.getComputedStyle(current).backgroundColor);
    if (colour !== null) {
      // Rec. 601 luma is enough to separate a dark surface from a light one.
      const luma = (0.299 * colour.r + 0.587 * colour.g + 0.114 * colour.b) / 255;
      return luma < 0.5 ? 'dark' : 'light';
    }
    current = current.parentElement;
  }
  return 'light';
}

function parseColour(value: string): { r: number; g: number; b: number } | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/u.exec(
    value.trim()
  );
  if (match === null) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  // A transparent surface is not the colour anything is read against.
  if (!Number.isFinite(alpha) || alpha < 0.5) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** Wording for a fence past the per-document diagram budget. */
export const DIAGRAM_BUDGET_NOTE = `Only the first ${String(
  MERMAID_LIMITS.maxDiagramsPerDocument
)} diagrams in a document are drawn. The source is shown instead.`;
