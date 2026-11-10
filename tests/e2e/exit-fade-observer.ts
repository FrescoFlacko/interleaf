import type { Page } from '@playwright/test';
import type { ExitEvidence } from './exit-fade-evidence';

/** Arm on the actual renderer before the existing click; never drive its animation. */
export async function armExitFadeObserver(page: Page, selector: string, side: 'left' | 'right'): Promise<void> {
  await page.evaluate(({ selector, side }) => {
    const box = document.querySelector<HTMLElement>(selector)!;
    const content = box.querySelector<HTMLElement>('[data-testid$="-content"]')!;
    const button = document.querySelector<HTMLElement>(`[data-testid="toggle-${side}-panel"]`)!;
    let closingAnimation: Animation | null = null;
    const read = () => {
      const style = getComputedStyle(content);
      const animation = content.getAnimations().find((item) => item instanceof CSSTransition && item.transitionProperty === 'opacity');
      const rect = box.getBoundingClientRect();
      return { t: performance.now(), phase: box.dataset.panelState ?? null, opacity: Number(style.opacity), width: rect.width, left: rect.left,
        x: style.transform === 'none' ? 0 : Math.abs(new DOMMatrixReadOnly(style.transform).m41), duration: parseFloat(style.transitionDuration) * 1000,
        property: style.transitionProperty, overflow: document.body.scrollWidth - document.body.clientWidth,
        inert: box.inert, ariaHidden: box.getAttribute('aria-hidden'),
        animationStart: animation === closingAnimation && typeof animation.startTime === 'number' ? animation.startTime : null };
    };
    const record: ExitEvidence = { click: null, initial: read(), closing: null, terminal: null, frames: [], starts: [] };
    Object.assign(window, { __exitFadeEvidence: record });
    button.addEventListener('click', () => { record.initial = read(); record.click = record.initial.t; }, { capture: true, once: true });
    const observer = new MutationObserver(() => {
      const sample = read();
      if (sample.phase === 'closing' && record.closing === null) {
        const animation = content.getAnimations().find((item) => item instanceof CSSTransition && item.transitionProperty === 'opacity');
        closingAnimation = animation ?? null;
        const duration = animation?.effect?.getComputedTiming().duration;
        const keyframes = animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
        const from = keyframes[0]?.opacity;
        const to = keyframes.at(-1)?.opacity;
        record.closing = { ...sample, opacityAnimation: animation?.playState === 'running', animationDuration: typeof duration === 'number' ? duration : null,
          opacityFrom: from === undefined ? null : Number(from), opacityTo: to === undefined ? null : Number(to) };
        if (animation) {
          void animation.ready.then(() => {
            if (typeof animation.startTime === 'number') record.starts.push({ t: performance.now(), start: animation.startTime });
          }, () => { /* A cancelled transition supplies no start evidence. */ });
        }
      }
      if (sample.phase === 'closed') { record.terminal = sample; observer.disconnect(); }
    });
    observer.observe(box, { attributes: true, attributeFilter: ['data-panel-state'] });
    const tick = () => { record.frames.push(read()); if (record.click === null || performance.now() - record.click < 750) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { selector, side });
}
