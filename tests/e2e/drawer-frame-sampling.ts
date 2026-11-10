import { expect } from '@playwright/test';
import type { AppHandle } from './helpers';
import { EXIT_PROTOCOL_WINDOW_MS, exitProtocolWindow, type ExitEvidence } from './exit-fade-evidence';

export const SETTLE_MS = 650;

export type Frame = {
  readonly t: number;
  readonly observedAt: number;
  readonly clickAt: number | null;
  readonly w: number;
  /** Horizontal travel of the panel's content, in px. */
  readonly tx: number;
  /** Opacity of the panel's content. */
  readonly op: number;
  readonly trProp: string;
  readonly trDur: string;
  readonly overflowX: number;
};

async function readFrame(app: AppHandle, selector: string): Promise<{
  observedAt: number; clickAt: number | null; frame: Frame | null;
}> {
  return await app.window.evaluate((sel) => {
    const node = document.querySelector<HTMLElement>(sel);
    const content = document.querySelector<HTMLElement>(`${sel} > [data-testid$="-content"]`);
    const clickAt = (Reflect.get(window, '__exitFadeEvidence') as ExitEvidence | undefined)?.click ?? null;
    if (node === null || content === null) return { observedAt: performance.now(), clickAt, frame: null };
    const cs = getComputedStyle(content);
    const measurements = {
      w: Math.round(node.getBoundingClientRect().width * 100) / 100,
      tx: cs.transform === 'none' ? 0 : Math.round(Math.abs(new DOMMatrixReadOnly(cs.transform).m41) * 100) / 100,
      op: Math.round(Number.parseFloat(cs.opacity) * 1000) / 1000,
      trProp: cs.transitionProperty,
      trDur: cs.transitionDuration,
      overflowX: document.body.scrollWidth - document.body.clientWidth,
    };
    // A layout read can itself block; timestamp after every measured value so
    // a post-deadline terminal can never be admitted as an earlier sample.
    const observedAt = performance.now();
    const frame = { t: Math.round(observedAt), observedAt, clickAt, ...measurements };
    return { observedAt, clickAt, frame };
  }, selector);
}

/** Samples real protocol reads across the original entry settle window. */
export async function sampleFrames(app: AppHandle, selector: string): Promise<readonly Frame[]> {
  const collected: Frame[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt <= SETTLE_MS) {
    const { frame } = await readFrame(app, selector);
    if (frame !== null) {
      collected.push(frame);
      expect(frame.overflowX).toBeLessThanOrEqual(1);
    }
    await app.window.waitForTimeout(16);
  }
  return collected;
}

/** Arm before input, admitting only actual reads within 500 ms of its real click. */
export async function sampleExitFrames(app: AppHandle, selector: string): Promise<readonly Frame[]> {
  const collected: Frame[] = [];
  const startedAt = Date.now();
  let clickAt: number | null = null;
  let observedAt = 0;
  while (clickAt === null || observedAt - clickAt <= EXIT_PROTOCOL_WINDOW_MS) {
    if (clickAt === null && Date.now() - startedAt > 15_000) throw new Error('The real toggle click was not observed');
    const sample = await readFrame(app, selector);
    if (sample.frame !== null) collected.push(sample.frame);
    clickAt = sample.clickAt;
    observedAt = sample.observedAt;
    await app.window.waitForTimeout(16);
  }
  console.log('EXIT_PROTOCOL_SAMPLES', JSON.stringify({ click: clickAt, frames: collected }));
  const inWindow = exitProtocolWindow(collected, clickAt);
  for (const frame of inWindow) expect(frame.overflowX).toBeLessThanOrEqual(1);
  return inWindow;
}
