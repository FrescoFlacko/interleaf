/**
 * Frame recording for a desktop panel toggle, timed from the user's action.
 *
 * `installIntentRecorder` runs in the page (it is passed whole to
 * `evaluateHandle`, so it must not use anything outside itself). It is armed
 * before the action and keeps one baseline sample of the resting panel. Its
 * window starts at the trusted click on the expected toggle, in the capture
 * phase before the app handles it, or at the expected key chord; the time the
 * test driver spent getting the action delivered is not part of it. Inside the
 * window it samples on every animation frame and every panel state change,
 * and records when the content's own opacity transition reports its end. A
 * frame that runs after the window is counted, never recorded, so nothing
 * observed late can satisfy a check. The recorder stops by itself at the end
 * of the window, or at its arm deadline if the action never arrives, and
 * `dispose` stops it at once; afterwards nothing it scheduled acts.
 */

export type IntentSpec =
  | { readonly kind: 'click'; readonly testId: string }
  | { readonly kind: 'key'; readonly key: string; readonly ctrlKey: boolean; readonly shiftKey: boolean };

export type RecorderOptions = {
  readonly selector: string;
  readonly intent: IntentSpec;
  /** How long after the action to record. */
  readonly windowMs: number;
  /** How long to wait for the action before giving up. */
  readonly armDeadlineMs: number;
  /** Accept only browser-generated (trusted) events; on unless a test cannot produce them. */
  readonly requireTrusted?: boolean;
};

/** One sample: the same reads the frame-sampled specs always made. */
type RecordedFrame = {
  readonly t: number;
  readonly w: number;
  readonly tx: number;
  readonly op: number;
  readonly trProp: string;
  readonly trDur: string;
  readonly overflowX: number;
  readonly source: 'baseline' | 'intent' | 'frame' | 'mutation';
};

export type IntentRecording = {
  status: 'armed' | 'recording' | 'done' | 'no-intent';
  baseline: RecordedFrame | null;
  /** `performance.now()` at the action, or null before it. */
  intentAt: number | null;
  /** Samples from the action on, all inside the window. */
  frames: RecordedFrame[];
  /** Milliseconds from the action to the content's opacity `transitionend`, if inside the window. */
  fadeEndAt: number | null;
  /** Frames or changes that arrived after the window and were not recorded. */
  lateCallbacks: number;
};

export type IntentRecorder = IntentRecording & { readonly dispose: () => void };

export function installIntentRecorder(options: RecorderOptions): IntentRecorder {
  const panel = document.querySelector<HTMLElement>(options.selector);
  const content = document.querySelector<HTMLElement>(`${options.selector} > [data-testid$="-content"]`);
  if (panel === null || content === null) throw new Error(`No panel ${options.selector} to record.`);
  const sample = (source: RecordedFrame['source']): RecordedFrame => {
    const styles = getComputedStyle(content);
    return {
      t: Math.round(performance.now()),
      w: Math.round(panel.getBoundingClientRect().width * 100) / 100,
      tx: styles.transform === 'none' || styles.transform === '' ? 0 : Math.round(Math.abs(new DOMMatrixReadOnly(styles.transform).m41) * 100) / 100,
      op: Math.round(Number.parseFloat(styles.opacity === '' ? '1' : styles.opacity) * 1000) / 1000,
      trProp: styles.transitionProperty,
      trDur: styles.transitionDuration,
      overflowX: document.body.scrollWidth - document.body.clientWidth,
      source,
    };
  };
  const trusted = (event: Event): boolean => event.isTrusted || options.requireTrusted === false;
  let frame = 0;
  let windowTimer = 0;
  const inWindow = (): boolean => recorder.intentAt !== null && performance.now() <= recorder.intentAt + options.windowMs;
  const stop = (status: IntentRecording['status']): void => {
    if (recorder.status === 'done' || recorder.status === 'no-intent') return;
    recorder.status = status;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(armTimer);
    window.clearTimeout(windowTimer);
    observer.disconnect();
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    content.removeEventListener('transitionend', onTransitionEnd);
  };
  const record = (source: RecordedFrame['source']): boolean => {
    if (recorder.status !== 'recording') return false;
    if (!inWindow()) {
      recorder.lateCallbacks += 1;
      stop('done');
      return false;
    }
    recorder.frames.push(sample(source));
    return true;
  };
  const onFrame = (): void => {
    if (record('frame')) frame = window.requestAnimationFrame(onFrame);
  };
  const begin = (): void => {
    recorder.intentAt = performance.now();
    recorder.status = 'recording';
    window.clearTimeout(armTimer);
    recorder.frames.push(sample('intent'));
    frame = window.requestAnimationFrame(onFrame);
    windowTimer = window.setTimeout(() => { stop('done'); }, options.windowMs);
  };
  const onClick = (event: MouseEvent): void => {
    if (recorder.status !== 'armed' || !trusted(event) || options.intent.kind !== 'click') return;
    if (!(event.target instanceof Element) || event.target.closest(`[data-testid="${options.intent.testId}"]`) === null) return;
    begin();
  };
  const onKey = (event: KeyboardEvent): void => {
    const intent = options.intent;
    if (recorder.status !== 'armed' || !trusted(event) || intent.kind !== 'key') return;
    if (event.key !== intent.key || event.ctrlKey !== intent.ctrlKey || event.shiftKey !== intent.shiftKey) return;
    begin();
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target !== content || event.propertyName !== 'opacity' || recorder.intentAt === null || recorder.fadeEndAt !== null) return;
    if (recorder.status === 'recording' && inWindow()) recorder.fadeEndAt = Math.round(performance.now() - recorder.intentAt);
  };
  const observer = new MutationObserver(() => { record('mutation'); });
  const recorder: IntentRecorder = {
    status: 'armed',
    baseline: sample('baseline'),
    intentAt: null,
    frames: [],
    fadeEndAt: null,
    lateCallbacks: 0,
    dispose: () => { stop('done'); },
  };
  const armTimer = window.setTimeout(() => { if (recorder.status === 'armed') stop('no-intent'); }, options.armDeadlineMs);
  observer.observe(panel, { attributes: true, attributeFilter: ['data-panel-state', 'style'] });
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  content.addEventListener('transitionend', onTransitionEnd);
  return recorder;
}
