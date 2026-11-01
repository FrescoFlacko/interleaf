import { SLIDE_COMPLETION_GRACE_MS } from "./slide-presence";

/**
 * The content's fade-out on close, matching `--dur-exit`: the width is
 * committed to 0 only after it, so the band is never seen empty.
 */
const PANEL_EXIT_MS = 100;

/** When a fade that ran on time, from its start, has certainly ended. */
export const PANEL_EXIT_EXPECTED_MS = PANEL_EXIT_MS + SLIDE_COMPLETION_GRACE_MS;

/**
 * Safety ceiling, from close intent and never restarted by a phase: the
 * close's whole 650ms budget. A close's first faded frame may come as late as
 * +550ms; its 100ms fade then ends, and releases the width itself, by +650ms,
 * so the ceiling never falls before the end of a fade that can still finish in
 * time (one ending exactly at +650ms releases once, by whichever comes first).
 * It releases the width of a close whose preparation never got its frames or
 * whose fade never reports its end, and bounds how long a stalled close holds
 * the band. It is not the fade's duration, which stays 100ms. If no frame
 * arrives before it, no fade is seen: nothing can present frames the host does
 * not produce, and a host that holds the page's own timers back longer still
 * delays this release too.
 */
export const PANEL_EXIT_CEILING_MS = 650;

/**
 * Calls `ready` once the page has rendered at least one frame since it was
 * scheduled: the first frame paints the prepared state, the callback runs at
 * the start of the next. This only waits for a rendering opportunity; it does
 * not prove the compositor or GPU finished anything. Returns a cancel.
 */
export function afterPreparedFrame(ready: () => void): () => void {
  let second = 0;
  const first = window.requestAnimationFrame(() => {
    second = window.requestAnimationFrame(ready);
  });
  return () => {
    window.cancelAnimationFrame(first);
    if (second !== 0) window.cancelAnimationFrame(second);
  };
}

type Fade = Pick<Animation, "finished">;

/** The content's own opacity transition while it can still end, if any. */
function pendingOrRunningFade(content: HTMLElement | null): Fade | null {
  if (content === null || typeof content.getAnimations !== "function") return null;
  return (
    content.getAnimations().find(
      (animation) =>
        "transitionProperty" in animation &&
        animation.transitionProperty === "opacity" &&
        (animation.playState === "running" || animation.playState === "paused"),
    ) ?? null
  );
}

/**
 * Watches one fade of a panel's content, from its start, and calls `release`
 * once, when the width may be committed to 0 (Defect 22). The fade decides:
 * its opacity `transitionend`, or its animation actually finishing or being
 * cancelled. At the expected end, a fade with nothing to wait for (no
 * transition, or one that ended unreported) is released; one still waiting
 * for its first frame, or still running, keeps the width held, so a slow host
 * delays the release instead of cutting the fade short. The close's own
 * ceiling (`PANEL_EXIT_CEILING_MS`) bounds the wait. The returned stop cancels
 * it all, and nothing it scheduled acts afterwards.
 */
export function watchPanelFade(content: HTMLElement | null, release: () => void): () => void {
  let live = true;
  const stop = (): void => {
    live = false;
    window.clearTimeout(expected);
    content?.removeEventListener("transitionend", onTransitionEnd);
  };
  const end = (): void => {
    if (!live) return;
    stop();
    release();
  };
  const follow = (fade: Fade): void => {
    fade.finished.then(end, end);
  };
  function onTransitionEnd(event: TransitionEvent): void {
    if (event.target === content && event.propertyName === "opacity") end();
  }
  const fade = pendingOrRunningFade(content);
  if (fade !== null) follow(fade);
  const expected = window.setTimeout(() => {
    const current = pendingOrRunningFade(content);
    if (current === null) end();
    else if (current !== fade) follow(current);
  }, PANEL_EXIT_EXPECTED_MS);
  content?.addEventListener("transitionend", onTransitionEnd);
  return stop;
}
