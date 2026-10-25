import type { CloneableRecord, CloneableValue } from '@shared/models/portable';

/**
 * The bounds and message shapes of the AI-output diagram worker.
 *
 * A diagram in a chat reply or an agent report is model output, so its source
 * is untrusted declarative data. Every limit here is checked before the source
 * reaches the worker, again inside it, and once more on what comes back: the
 * worker is a separate thread, not a trusted one.
 */

/** The font the drawing is measured in and later displayed with. */
export const DIAGRAM_FONT_FAMILY = 'sans-serif';
/** The font size, in CSS pixels, the drawing is measured in and later displayed with. */
export const DIAGRAM_FONT_SIZE_PX = 14;
/** Longest diagram source rendered, in characters. */
export const MAX_DIAGRAM_SOURCE_CHARS = 8_000;
/** Most source lines rendered. */
export const MAX_DIAGRAM_SOURCE_LINES = 300;
/** Pele's own parse bound on edges. */
export const MAX_DIAGRAM_EDGES = 200;
/** Longest SVG the worker may return, in characters. */
export const MAX_DIAGRAM_SVG_CHARS = 400_000;
/** Largest width or height of a returned drawing, in CSS pixels. */
export const MAX_DIAGRAM_DIMENSION = 4_000;
/** Diagrams rendered per message; any after that stay as source. */
export const MAX_DIAGRAMS_PER_MESSAGE = 6;
/** Hard wall-clock limit for one render; the worker is terminated after it. */
export const DIAGRAM_RENDER_TIMEOUT_MS = 4_000;
/** Renders waiting behind the active one; further requests are refused. */
export const MAX_QUEUED_DIAGRAM_RENDERS = 24;

/** Why a diagram is shown as source. Never carries source text or library messages. */
export type DiagramFailure = 'unsupported' | 'invalid' | 'too-large' | 'timeout' | 'busy' | 'failed';

export type DiagramRenderRequest = { readonly id: number; readonly source: string };

export type DiagramRenderSuccess = {
  readonly id: number;
  readonly ok: true;
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly kind: string;
};

type DiagramRenderFailure = { readonly id: number; readonly ok: false; readonly failure: DiagramFailure };

export type DiagramRenderResponse = DiagramRenderSuccess | DiagramRenderFailure;

const FAILURES: ReadonlySet<string> = new Set<DiagramFailure>([
  'unsupported',
  'invalid',
  'too-large',
  'timeout',
  'busy',
  'failed',
]);

const KIND_PATTERN = /^[A-Za-z]{1,24}$/u;

/** A source the worker should not even be asked to parse, or `null` when it is in bounds. */
export function sourceLimitFailure(source: string): DiagramFailure | null {
  if (source.trim().length === 0) return 'invalid';
  if (source.length > MAX_DIAGRAM_SOURCE_CHARS) return 'too-large';
  if (source.split('\n').length > MAX_DIAGRAM_SOURCE_LINES) return 'too-large';
  return null;
}

function isPositiveDimension(value: CloneableValue): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DIAGRAM_DIMENSION;
}

function isRecord(value: CloneableValue): value is CloneableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a worker message as a response to request `id`, or `null` when it is
 * not one. Anything outside the declared shape and bounds is rejected rather
 * than coerced, and a success that exceeds a bound becomes a failure.
 */
export function parseDiagramResponse(value: CloneableValue, id: number): DiagramRenderResponse | null {
  if (!isRecord(value) || value.id !== id) return null;
  if (value.ok === false) {
    return typeof value.failure === 'string' && FAILURES.has(value.failure)
      ? { id, ok: false, failure: value.failure as DiagramFailure }
      : { id, ok: false, failure: 'failed' };
  }
  if (value.ok !== true) return null;
  const { svg, width, height, kind } = value;
  if (typeof svg !== 'string' || svg.length === 0) return { id, ok: false, failure: 'failed' };
  if (svg.length > MAX_DIAGRAM_SVG_CHARS) return { id, ok: false, failure: 'too-large' };
  if (!isPositiveDimension(width) || !isPositiveDimension(height)) return { id, ok: false, failure: 'too-large' };
  const safeKind = typeof kind === 'string' && KIND_PATTERN.test(kind) ? kind : 'diagram';
  return { id, ok: true, svg, width, height, kind: safeKind };
}
