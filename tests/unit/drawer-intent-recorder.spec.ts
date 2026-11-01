// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installIntentRecorder, type IntentRecorder } from '../e2e/drawer-intent-recorder';

/**
 * The drawer frame recorder times a panel toggle from the user's own action:
 * it is armed before the action, keeps a baseline of the resting panel, and
 * starts its fixed window at the trusted click on the expected toggle (or the
 * expected key chord), never at the moment the test driver happened to start.
 * It records on animation frames and panel mutations inside that window only,
 * and stops by itself. Frames and the clock are driven by hand here.
 */

let now = 0;
const queued = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function runFrame(): void {
  const due = [...queued.entries()];
  queued.clear();
  for (const [, callback] of due) callback(now);
}

function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

function buildPanel(): { readonly panel: HTMLElement; readonly content: HTMLElement; readonly toggle: HTMLButtonElement } {
  const toggle = document.createElement('button');
  toggle.dataset.testid = 'toggle-left-panel';
  const panel = document.createElement('div');
  panel.dataset.testid = 'resizable-panel-left';
  const content = document.createElement('div');
  content.dataset.testid = 'resizable-panel-left-content';
  content.style.opacity = '1';
  panel.append(content);
  document.body.append(toggle, panel);
  return { panel, content, toggle };
}

/**
 * jsdom cannot produce trusted events, so these cases arm the recorder with
 * `requireTrusted: false`; one case checks the default refuses untrusted ones.
 */
function trustedClick(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function trustedKey(init: KeyboardEventInit): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

const OPTIONS = {
  selector: '[data-testid="resizable-panel-left"]',
  intent: { kind: 'click', testId: 'toggle-left-panel' },
  windowMs: 650,
  armDeadlineMs: 5_000,
  requireTrusted: false,
} as const;

let recorder: IntentRecorder | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  now = 1_000;
  queued.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true, writable: true,
    value: (callback: FrameRequestCallback): number => { const id = nextFrameId++; queued.set(id, callback); return id; },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true, writable: true,
    value: (id: number): void => { queued.delete(id); },
  });
  document.body.replaceChildren();
});

afterEach(() => {
  recorder?.dispose();
  recorder = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('drawer intent recorder', () => {
  it('starts its window at the click, however long the action took to arrive', () => {
    const { toggle } = buildPanel();
    recorder = installIntentRecorder(OPTIONS);
    expect(recorder.baseline?.op).toBe(1);
    // A slow actionability wait: 400ms pass before the click lands.
    advance(400);
    runFrame();
    expect(recorder.frames).toHaveLength(0);
    trustedClick(toggle);
    expect(recorder.status).toBe('recording');
    expect(recorder.intentAt).toBe(1_400);
    for (let frame = 0; frame < 30; frame += 1) { advance(16); runFrame(); }
    // 30 frames x 16ms = 480ms: all still inside the 650ms after the click.
    expect(recorder.frames.filter((frame) => frame.source === 'frame')).toHaveLength(30);
    expect(recorder.status).toBe('recording');
  });

  it('records nothing after the window and stops on its own, even when frames stall', () => {
    const { toggle, panel } = buildPanel();
    recorder = installIntentRecorder(OPTIONS);
    trustedClick(toggle);
    advance(16); runFrame();
    // Frames stall past the end of the window; a later frame is not a sample.
    advance(700);
    expect(recorder.status).toBe('done');
    panel.style.width = '0px';
    runFrame();
    expect(recorder.frames.every((frame) => frame.t <= recorder!.intentAt! + 650)).toBe(true);
    expect(queued.size).toBe(0);
  });

  it('a frame that runs late is counted, not recorded', () => {
    const { toggle } = buildPanel();
    recorder = installIntentRecorder({ ...OPTIONS, armDeadlineMs: 50_000 });
    trustedClick(toggle);
    // The deadline timer is held back behind a stalled event loop: only the time moves.
    now += 700;
    runFrame();
    expect(recorder.lateCallbacks).toBe(1);
    expect(recorder.frames.filter((frame) => frame.source === 'frame')).toHaveLength(0);
    expect(recorder.status).toBe('done');
  });

  it('by default refuses an event the browser did not generate', () => {
    const { toggle } = buildPanel();
    recorder = installIntentRecorder({ ...OPTIONS, requireTrusted: true });
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(recorder.intentAt).toBeNull();
    expect(recorder.status).toBe('armed');
  });

  it('ignores clicks elsewhere and a second click', () => {
    const { toggle } = buildPanel();
    const other = document.createElement('button');
    document.body.append(other);
    recorder = installIntentRecorder(OPTIONS);
    trustedClick(other);
    expect(recorder.intentAt).toBeNull();
    advance(10);
    trustedClick(toggle);
    advance(20);
    trustedClick(toggle);
    expect(recorder.intentAt).toBe(1_010);
  });

  it('a key intent starts only on its exact chord', () => {
    buildPanel();
    recorder = installIntentRecorder({ ...OPTIONS, intent: { kind: 'key', key: 'A', ctrlKey: true, shiftKey: true } });
    trustedKey({ key: 'A', ctrlKey: true, shiftKey: false });
    trustedKey({ key: 'a', ctrlKey: true, shiftKey: true });
    expect(recorder.intentAt).toBeNull();
    advance(5);
    trustedKey({ key: 'A', ctrlKey: true, shiftKey: true });
    expect(recorder.intentAt).toBe(1_005);
  });

  it('reports a missing action at its arm deadline and leaves nothing running', () => {
    buildPanel();
    recorder = installIntentRecorder(OPTIONS);
    advance(5_000);
    expect(recorder.status).toBe('no-intent');
    expect(queued.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records the opacity end event of the content only, inside the window', () => {
    const { toggle, content } = buildPanel();
    recorder = installIntentRecorder(OPTIONS);
    trustedClick(toggle);
    advance(50);
    content.firstChild?.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' }));
    content.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }));
    expect(recorder.fadeEndAt).toBeNull();
    advance(70);
    content.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' }));
    expect(recorder.fadeEndAt).toBe(120);
  });

  it('dispose stops everything at once', () => {
    const { toggle } = buildPanel();
    recorder = installIntentRecorder(OPTIONS);
    trustedClick(toggle);
    advance(16); runFrame();
    recorder.dispose();
    expect(queued.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(recorder.status).toBe('done');
  });
});
