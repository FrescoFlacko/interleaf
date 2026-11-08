// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { confirmPdfLearningRange } from '../../src/renderer/features/reader/pdf-learning-navigation';

const anchor = { format: 'pdf' as const, pageIndex: 5, textStart: 0, textEnd: 20, quote: { exact: 'EXACTPDFREVIEWMARKER', prefix: '', suffix: '' } };
const rect = { top: 120, bottom: 140, left: 20, right: 180, width: 160, height: 20, x: 20, y: 120, toJSON: () => ({}) };
function fixture() {
  document.body.innerHTML = '<div data-testid="pdf-scroll-container"><div data-testid="pdf-textlayer-p6"></div></div>';
  const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p6"]');
  const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
  if (!layer || !scroller) throw new Error('Missing PDF fixture');
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] });
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ ...rect, top: 99, bottom: 873, left: 0, right: 700 });
  scroller.scrollTo = vi.fn();
  return { layer, scroller };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('waits for completion even when an unfinished layer already has partial text', async () => {
  const { layer, scroller } = fixture();
  const pending = confirmPdfLearningRange(anchor, () => true);
  layer.textContent = 'EXACTPDFREVIEWMARKER';
  await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  layer.dataset.pdfTextReady = 'true';
  expect(await pending).toBe(true);
  expect(scroller.scrollTo).toHaveBeenCalledOnce();
});

it('does not scroll when ownership is cancelled before render completes', async () => {
  const { layer, scroller } = fixture();
  let current = true;
  const pending = confirmPdfLearningRange(anchor, () => current);
  current = false;
  layer.textContent = anchor.quote.exact;
  layer.dataset.pdfTextReady = 'true';
  expect(await pending).toBe(false);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

it('fails honestly when the completed layer lacks the requested text', async () => {
  const { layer, scroller } = fixture();
  layer.textContent = 'different text';
  layer.dataset.pdfTextReady = 'true';
  expect(await confirmPdfLearningRange(anchor, () => true)).toBe(false);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

it('does not claim success for a valid range hidden by the reader error overlay', async () => {
  const { layer, scroller } = fixture();
  layer.textContent = anchor.quote.exact;
  layer.dataset.pdfTextReady = 'true';
  const overlay = document.createElement('div');
  overlay.dataset.testid = 'reader-error';
  document.body.appendChild(overlay);
  const pending = confirmPdfLearningRange(anchor, () => true);
  await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  overlay.remove();
  expect(await pending).toBe(true);
});

it('waits for laid out range geometry after the text render is committed', async () => {
  const { layer, scroller } = fixture();
  layer.textContent = anchor.quote.exact;
  layer.dataset.pdfTextReady = 'true';
  let ready = false;
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => ready ? [rect] : [] });
  const pending = confirmPdfLearningRange(anchor, () => true);
  await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  ready = true;
  expect(await pending).toBe(true);
});

it('terminates without scrolling if the target layer never completes', async () => {
  vi.useFakeTimers();
  const { scroller } = fixture();
  const pending = confirmPdfLearningRange(anchor, () => true);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await pending).toBe(false);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});
