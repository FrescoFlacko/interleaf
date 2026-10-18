import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * Shared open/close transition plumbing for panel toggles (Defect 22).
 *
 * State changes are CSS-driven; this module only owns the presence phases so a
 * close gets a REAL exit phase (content stays mounted, non-interactive and
 * inert while it animates out) instead of an immediate unmount/display:none.
 * prefers-reduced-motion is honored twice: the global stylesheet collapses all
 * transition durations to ~0 (styles/global.css), and the timers below resolve
 * immediately so state never waits behind an unused animation.
 */

/**
 * Single source of truth for drawer and panel slide timing; it matches
 * `--dur-slow` in styles/tokens.css, and CSS durations must match it.
 */
export const SLIDE_TRANSITION_MS = 280;
/** Grace past the CSS duration before presence finalizes; keeps slow frames from cutting the exit early. */
export const SLIDE_COMPLETION_GRACE_MS = 80;

export type SlidePhase = 'entering' | 'open' | 'exiting';

export type SlidePresence = {
  /** Whether content is currently mounted (including during exit). */
  readonly present: boolean;
  readonly phase: SlidePhase;
};

/** Reads the OS preference once per call site render pass. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initialPresence(desired: boolean, animateMount: boolean): SlidePresence {
  if (!desired) return { present: false, phase: 'exiting' };
  return animateMount && !prefersReducedMotion() ? { present: true, phase: 'entering' } : { present: true, phase: 'open' };
}

/**
 * Keeps exactly one mounted instance per caller for as long as an enter or
 * exit transition can be running. `desired=false` with nothing mounted stays
 * unmounted; re-entering during an exit cancels the exit in place. `exitMs` is
 * the caller's own CSS exit duration (dialogs leave faster than drawers).
 * `animateMount` makes a caller that mounts already open (a dialog rendered
 * only while it is wanted) start in `entering`, so it still transitions in.
 */
export function useSlidePresence(
  desired: boolean,
  exitMs: number = SLIDE_TRANSITION_MS,
  animateMount = false,
): SlidePresence {
  const [presence, setPresence] = useState<SlidePresence>(() => initialPresence(desired, animateMount));

  // Pre-paint presence establishment: the flip applies on the SAME commit
  // that renders `desired`, so an outgoing drawer never paints as inert while
  // its replacement is still absent (compact open/switch included).
  useLayoutEffect(() => {
    setPresence((current) => {
      if (desired) {
        if (!current.present) {
          // Reduced motion skips the off-screen entering frames entirely.
          if (prefersReducedMotion()) return { present: true, phase: 'open' };
          return { present: true, phase: 'entering' };
        }
        if (current.phase === 'exiting') {
          return { present: true, phase: prefersReducedMotion() ? 'open' : 'entering' };
        }
        return current;
      }
      if (!current.present) return current;
      if (current.phase === 'open' || current.phase === 'entering') {
        // Reduced motion: the end state applies on this very commit.
        if (prefersReducedMotion()) return { present: false, phase: 'exiting' };
        return { ...current, phase: 'exiting' };
      }
      return current;
    });
  }, [desired]);

  // Enter starts at the off-screen transform so the flip to phase 'open'
  // transitions it in; double-rAF guarantees one painted hidden frame first.
  // Reduced motion resolves to 'open' synchronously (no off-screen delay).
  useLayoutEffect(() => {
    if (!presence.present || presence.phase !== 'entering') return;
    if (prefersReducedMotion()) {
      setPresence((current) =>
        current.present && current.phase === 'entering' ? { ...current, phase: 'open' } : current
      );
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setPresence((current) =>
          current.present && current.phase === 'entering' ? { ...current, phase: 'open' } : current
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== 0) window.cancelAnimationFrame(secondFrame);
    };
  }, [presence.phase, presence.present]);

  // Exit completes after the fixed slide budget regardless of whether a real
  // transitionend fires (jsdom delivers none); reduced motion resolves now.
  useEffect(() => {
    if (!presence.present || presence.phase !== 'exiting') return;
    if (prefersReducedMotion()) {
      setPresence({ present: false, phase: 'exiting' });
      return;
    }
    const timer = window.setTimeout(() => {
      setPresence((current) =>
        current.present && current.phase === 'exiting' ? { present: false, phase: 'exiting' } : current
      );
    }, exitMs + SLIDE_COMPLETION_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [presence.phase, presence.present, exitMs]);

  return presence;
}
