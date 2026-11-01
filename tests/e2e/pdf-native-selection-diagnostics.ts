import type { Page, TestInfo } from '@playwright/test';
import type { Thrown } from './owned-run-cleanup';

/**
 * Failure-only diagnostics for a native mouse selection in the PDF reader, so a
 * hosted failure of the selection toolbar says what the page held at that
 * moment instead of only that the toolbar never appeared.
 *
 * Contract:
 * - The guarded step runs exactly as written. On success nothing else runs: no
 *   wait, read or action is added before native input or after the step.
 * - Only when the step throws, one passive snapshot is read and attached to the
 *   test results. It reads the selection, the text layers, what the drag points
 *   hit and the scroll state; it never selects, focuses, scrolls or dispatches.
 * - Capture and attachment are each bounded and never throw: a failed, hung or
 *   dead page is recorded as such, and teardown is not held up.
 * - Whatever the step threw is rethrown as that exact value.
 */

/** Upper bound for each of capture and attachment, well inside the test timeout. */
const DIAGNOSTIC_BOUND_MS = 1_500;

const PDF_SELECTION_ATTACHMENT = 'pdf-native-selection-diagnostics';

export type Bounded<T> =
  | { readonly status: 'captured'; readonly value: T }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'timed-out'; readonly afterMs: number };

/** Never throws, even for an error whose fields throw when read. */
function describeThrown(thrown: Thrown): string {
  try {
    if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`.slice(0, 500);
    return `non-error value of type ${typeof thrown}`;
  } catch {
    return 'undescribable thrown value';
  }
}

/** Runs `work` for at most `boundMs`; never throws and leaves no timer behind. */
export async function bounded<T>(work: () => Promise<T>, boundMs: number): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => { resolve({ status: 'timed-out', afterMs: boundMs }); }, boundMs);
  });
  const outcome = Promise.resolve()
    .then(work)
    .then(
      (value): Bounded<T> => ({ status: 'captured', value }),
      (thrown: Thrown): Bounded<T> => ({ status: 'failed', error: describeThrown(thrown) }),
    );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `step`; if it throws, attaches a bounded `capture` and rethrows exactly
 * what the step threw.
 */
export async function runWithFailureCapture<Snapshot>(
  step: () => Promise<void>,
  capture: () => Promise<Snapshot>,
  attach: (body: string) => Promise<void>,
  boundMs: number = DIAGNOSTIC_BOUND_MS,
): Promise<void> {
  try {
    await step();
  } catch (thrown) {
    // `bounded` never throws; the catch only keeps a future change from replacing `thrown`.
    await captureAndAttach(capture, attach, boundMs).catch(() => undefined);
    throw thrown;
  }
}

async function captureAndAttach<Snapshot>(capture: () => Promise<Snapshot>, attach: (body: string) => Promise<void>, boundMs: number): Promise<void> {
  const snapshot = await bounded(capture, boundMs);
  await bounded(() => attach(JSON.stringify(snapshot, null, 1)), boundMs);
}

export type DragPoints = { readonly startX: number; readonly endX: number; readonly y: number };

/**
 * Page-side reader, serialized into the page by `page.evaluate`, so it must not
 * use anything from this module's scope. Read-only: layout reads and
 * `elementFromPoint` only.
 */
export function readPdfSelectionState(points: DragPoints | null) {
  const clip = (text: string | null | undefined, max: number): string => (text ?? '').slice(0, max);
  const box = (rect: DOMRect) => ({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
  const layerOf = (node: Node): HTMLElement | null => {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>('.textLayer') ?? null;
  };
  const currentLayer = (layer: HTMLElement): boolean => {
    const id = layer.getAttribute('data-testid');
    return id !== null && document.querySelector(`.textLayer[data-testid="${id}"]`) === layer;
  };
  const endpoint = (node: Node, offset: number) => {
    const layer = layerOf(node);
    return {
      node: node.nodeName,
      offset,
      connected: node.isConnected,
      layer: layer?.getAttribute('data-testid') ?? null,
      layerConnected: layer?.isConnected ?? null,
      layerIsCurrent: layer === null ? null : currentLayer(layer),
      text: clip(node.textContent, 80),
    };
  };
  const hit = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    if (element === null) return null;
    return {
      tag: element.tagName,
      testid: element.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      layer: element.closest('.textLayer')?.getAttribute('data-testid') ?? null,
      text: clip(element.textContent, 80),
    };
  };
  const selection = document.getSelection();
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
  const active = document.activeElement;
  return {
    selection: {
      rangeCount: selection?.rangeCount ?? 0,
      collapsed: selection?.isCollapsed ?? null,
      text: clip(selection?.toString(), 200),
      start: range === null ? null : endpoint(range.startContainer, range.startOffset),
      end: range === null ? null : endpoint(range.endContainer, range.endOffset),
      rect: range === null ? null : box(range.getBoundingClientRect()),
    },
    layers: [...document.querySelectorAll<HTMLElement>('.textLayer')].map((layer) => ({
      testid: layer.getAttribute('data-testid'),
      connected: layer.isConnected,
      rect: box(layer.getBoundingClientRect()),
      spans: layer.querySelectorAll('span').length,
      totalScaleFactor: layer.style.getPropertyValue('--total-scale-factor') || null,
      previewScale: layer.style.getPropertyValue('--preview-scale') || null,
    })),
    points,
    hits: points === null ? null : { start: hit(points.startX, points.y), end: hit(points.endX, points.y) },
    scroll: scroller === null ? null : { top: scroller.scrollTop, left: scroller.scrollLeft, height: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    toolbarPresent: document.querySelector('[data-testid="annotation-selection-toolbar"]') !== null,
    focus: { documentHasFocus: document.hasFocus(), active: active === null ? null : { tag: active.tagName, testid: active.getAttribute('data-testid') } },
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  };
}

/** Guards one step of a PDF native-drag test with the failure-only snapshot. */
export function withPdfSelectionDiagnostics(page: Page, testInfo: TestInfo, points: DragPoints | null, step: () => Promise<void>): Promise<void> {
  return runWithFailureCapture(
    step,
    () => page.evaluate(readPdfSelectionState, points),
    (body) => testInfo.attach(PDF_SELECTION_ATTACHMENT, { body, contentType: 'application/json' }),
  );
}
