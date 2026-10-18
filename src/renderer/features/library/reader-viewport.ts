import type { ReaderState } from '../../stores/use-reader-store';

/**
 * Whether the reader is claiming the viewport at this instant.
 *
 * A document is claimed not only while it is open but also while its open is
 * still in flight: between the click that opened it and the store settling,
 * the session is already null while `isLoading` is still true. A library
 * destination click inside that window must go through the reader's own close
 * path either way — skipping the in-flight window once let a deferred open
 * complete after the user had already left for the library, reviving a reader
 * they had asked to leave with its capability still minted in main.
 */
export function readerOwnsViewport(
  state: Pick<ReaderState, 'session' | 'isLoading'>
): boolean {
  return state.session !== null || state.isLoading;
}
