// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bounded, readPdfSelectionState, runWithFailureCapture } from '../e2e/pdf-native-selection-diagnostics';
import type { Thrown } from '../e2e/owned-run-cleanup';

/**
 * The PDF native-drag failure diagnostics: they run only when the guarded step
 * fails, never replace or delay its error beyond their bound, and only read the
 * page.
 */

const never = (): Promise<never> => new Promise(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

describe('runWithFailureCapture', () => {
  it('adds nothing to a passing step: no capture, no attachment', async () => {
    const step = vi.fn(() => Promise.resolve());
    const capture = vi.fn(() => Promise.resolve({}));
    const attach = vi.fn(() => Promise.resolve());
    await runWithFailureCapture(step, capture, attach);
    expect(step).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('rethrows the exact original error after attaching the snapshot', async () => {
    const original = new Error('toolbar not visible within 5000ms');
    const attach = vi.fn<(body: string) => Promise<void>>(() => Promise.resolve());
    const run = runWithFailureCapture(() => Promise.reject(original), () => Promise.resolve({ selection: { text: 'x' } }), attach);
    await expect(run).rejects.toBe(original);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(JSON.parse(attach.mock.calls[0]?.[0] ?? '')).toEqual({ status: 'captured', value: { selection: { text: 'x' } } });
  });

  it('keeps the original error when the capture throws, recording the capture failure', async () => {
    const original = new Error('original');
    const attach = vi.fn<(body: string) => Promise<void>>(() => Promise.resolve());
    await expect(runWithFailureCapture(() => Promise.reject(original), () => Promise.reject(new Error('Target page closed')), attach)).rejects.toBe(original);
    expect(JSON.parse(attach.mock.calls[0]?.[0] ?? '')).toEqual({ status: 'failed', error: 'Error: Target page closed' });
  });

  it('keeps the original error when the capture hangs, within the bound', async () => {
    vi.useFakeTimers();
    const original = new Error('original');
    const attach = vi.fn<(body: string) => Promise<void>>(() => Promise.resolve());
    const run = runWithFailureCapture(() => Promise.reject(original), never, attach, 1_500);
    const settled = expect(run).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    expect(JSON.parse(attach.mock.calls[0]?.[0] ?? '')).toEqual({ status: 'timed-out', afterMs: 1_500 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original error when attaching throws or hangs', async () => {
    const original = new Error('original');
    await expect(runWithFailureCapture(() => Promise.reject(original), () => Promise.resolve({}), () => Promise.reject(new Error('attach failed')))).rejects.toBe(original);
    vi.useFakeTimers();
    const hanging = runWithFailureCapture(() => Promise.reject(original), () => Promise.resolve({}), never, 1_500);
    const settled = expect(hanging).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
  });

  it('rethrows a non-Error thrown value unchanged', async () => {
    const thrown = { reason: 'not an Error' } as Thrown;
    await expect(runWithFailureCapture(async () => { await Promise.resolve(); throw thrown; }, () => Promise.resolve({}), () => Promise.resolve())).rejects.toBe(thrown);
  });

  it('keeps the original error when the capture throws an error whose fields throw', async () => {
    const original = new Error('original');
    const hostile = Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('message getter'); } });
    const attach = vi.fn<(body: string) => Promise<void>>(() => Promise.resolve());
    await expect(runWithFailureCapture(() => Promise.reject(original), () => Promise.reject(hostile), attach)).rejects.toBe(original);
    expect(JSON.parse(attach.mock.calls[0]?.[0] ?? '')).toEqual({ status: 'failed', error: 'undescribable thrown value' });
  });

  it('turns a synchronous throw from the capture into a recorded failure', async () => {
    const outcome = await bounded(() => { throw new TypeError('sync'); }, 50);
    expect(outcome).toEqual({ status: 'failed', error: 'TypeError: sync' });
  });
});

describe('readPdfSelectionState', () => {
  // jsdom has no Range geometry; Chromium does.
  beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(5, 6, 7, 8) });
  });
  afterEach(() => {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });

  function pdfPage(): Text {
    document.body.innerHTML = `
      <div data-testid="pdf-scroll-container">
        <div class="pdf-page-wrapper" data-page-number="1" data-testid="pdf-page-1">
          <div class="textLayer" data-testid="pdf-textlayer-p1" style="--total-scale-factor: 1.4"><span>The reader engine decouples layout extraction.</span></div>
        </div>
      </div>`;
    const text = document.querySelector('.textLayer span')?.firstChild;
    if (!(text instanceof Text)) throw new Error('fixture text missing');
    return text;
  }

  it('reports the selection, its layer and the points it hit, without changing the selection or focus', () => {
    const text = pdfPage();
    const range = document.createRange();
    range.setStart(text, 17);
    range.setEnd(text, 45);
    const selection = document.getSelection();
    selection?.addRange(range);
    const span = document.querySelector('.textLayer span');
    document.elementFromPoint = vi.fn(() => span);
    const focused = document.activeElement;

    const state = readPdfSelectionState({ startX: 10, endX: 90, y: 20 });

    expect(state.selection).toMatchObject({ rangeCount: 1, collapsed: false, text: ' decouples layout extraction' });
    expect(state.selection.start).toMatchObject({ offset: 17, connected: true, layer: 'pdf-textlayer-p1', layerConnected: true, layerIsCurrent: true });
    expect(state.layers[0]).toMatchObject({ testid: 'pdf-textlayer-p1', connected: true, spans: 1, totalScaleFactor: '1.4' });
    expect(state.hits?.start).toMatchObject({ tag: 'SPAN', layer: 'pdf-textlayer-p1' });
    expect(state.scroll).toMatchObject({ top: 0, left: 0 });
    expect(state.toolbarPresent).toBe(false);
    expect(selection?.toString()).toBe(' decouples layout extraction');
    expect(selection?.getRangeAt(0)).toBe(range);
    expect(document.activeElement).toBe(focused);
  });

  it('reports a selection whose layer was replaced as collapsed outside any text layer', () => {
    const text = pdfPage();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    document.getSelection()?.addRange(range);
    const replacement = document.createElement('div');
    replacement.className = 'textLayer';
    replacement.setAttribute('data-testid', 'pdf-textlayer-p1');
    document.querySelector('.pdf-page-wrapper')?.replaceChildren(replacement);

    const state = readPdfSelectionState(null);

    expect(state.hits).toBeNull();
    expect(state.layers).toEqual([expect.objectContaining({ testid: 'pdf-textlayer-p1', connected: true, spans: 0 })]);
    expect(state.selection).toMatchObject({ rangeCount: 1, collapsed: true, text: '' });
    expect(state.selection.start).toMatchObject({ node: 'DIV', layer: null, layerIsCurrent: null });
  });
});
