import { useEffect, useRef, type RefObject } from 'react';

/** Distance from the bottom that still counts as "following the run". */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * Keeps a feed pinned to its latest entry without taking scrolling away from
 * the reader: incoming events only scroll the viewport while it is already at
 * the bottom, and opening a different session always starts at the latest
 * activity. `resetKey` changing forces the jump; `revision` only follows.
 */
export function usePinnedScroll(resetKey: string, revision: number): RefObject<HTMLDivElement | null> {
  const viewportRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleScroll = (): void => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      following.current = distance <= FOLLOW_THRESHOLD_PX;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => { viewport.removeEventListener('scroll', handleScroll); };
  }, []);

  useEffect(() => {
    following.current = true;
    const viewport = viewportRef.current;
    if (viewport !== null) viewport.scrollTop = viewport.scrollHeight;
  }, [resetKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || !following.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [revision]);

  return viewportRef;
}
