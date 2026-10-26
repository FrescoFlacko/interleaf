import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { DiagramFailure } from './diagram-protocol';
import {
  diagramImageUrl,
  readDiagramPalette,
  sanitizeDiagramSvg,
  type DiagramPalette,
  type SanitizedDiagram,
} from './diagram-image';
import { diagramRenderQueue } from './diagram-worker-host';

/** What one diagram fence shows: its source while waiting, a picture, or its source with a reason. */
export type DiagramView =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly url: string; readonly width: number; readonly height: number; readonly kind: string }
  | { readonly status: 'failed'; readonly failure: DiagramFailure };

type DiagramResult =
  | { readonly status: 'ready'; readonly diagram: SanitizedDiagram; readonly kind: string }
  | { readonly status: 'failed'; readonly failure: DiagramFailure };

/** Sanitized results kept across messages, so history and re-renders never re-run Pele. */
const MAX_CACHED_DIAGRAMS = 48;
const cache = new Map<string, DiagramResult>();

/** Failures that would recur for the same source; `busy` and cancellations are retried later. */
const LASTING_FAILURES: ReadonlySet<DiagramFailure> = new Set(['unsupported', 'invalid', 'too-large', 'timeout']);

function cached(source: string): DiagramResult | undefined {
  const hit = cache.get(source);
  if (hit === undefined) return undefined;
  cache.delete(source);
  cache.set(source, hit);
  return hit;
}

function remember(source: string, result: DiagramResult): void {
  if (result.status === 'failed' && !LASTING_FAILURES.has(result.failure)) return;
  cache.set(source, result);
  const oldest = cache.keys().next();
  if (cache.size > MAX_CACHED_DIAGRAMS && oldest.done !== true) cache.delete(oldest.value);
}

/** Clears remembered results. Tests only. */
export function clearDiagramCache(): void {
  cache.clear();
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
  };
}

/** The palette as a string, so an unchanged palette compares equal between renders. */
function paletteSnapshot(): string {
  return JSON.stringify(readDiagramPalette());
}

function sanitized(svg: string, kind: string): DiagramResult {
  try {
    return { status: 'ready', diagram: sanitizeDiagramSvg(svg), kind };
  } catch {
    return { status: 'failed', failure: 'failed' };
  }
}

function imageView(result: DiagramResult | undefined, palette: DiagramPalette): DiagramView {
  if (result === undefined) return { status: 'pending' };
  if (result.status === 'failed') return result;
  try {
    const url = diagramImageUrl(result.diagram, palette);
    return { status: 'ready', url, width: result.diagram.width, height: result.diagram.height, kind: result.kind };
  } catch {
    return { status: 'failed', failure: 'failed' };
  }
}

/**
 * Renders one complete diagram source off the UI thread and returns what to
 * show for it. The worker's SVG is rebuilt by the allow-list here, on the UI
 * thread, before it becomes an image. A source change or unmount cancels the
 * render it started, and a result for a source no longer shown is dropped.
 * The picture is redrawn in the new colours when the palette changes.
 */
export function useDiagramRender(source: string): DiagramView {
  const [settled, setSettled] = useState<{ readonly source: string; readonly result: DiagramResult } | null>(null);
  const palette = useSyncExternalStore(subscribeToTheme, paletteSnapshot);
  const result = settled?.source === source ? settled.result : cached(source);

  useEffect(() => {
    if (cache.has(source)) return undefined;
    const controller = new AbortController();
    void diagramRenderQueue()
      .render(source, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        const next: DiagramResult = outcome.ok
          ? sanitized(outcome.svg, outcome.kind)
          : { status: 'failed', failure: outcome.failure };
        remember(source, next);
        setSettled({ source, result: next });
      });
    return () => {
      controller.abort();
    };
  }, [source]);

  return useMemo(() => imageView(result, JSON.parse(palette) as DiagramPalette), [result, palette]);
}
