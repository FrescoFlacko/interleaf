import type { DocumentMetadata } from '../../src/shared/types/document';
import type { DocumentAdapter } from '../../src/renderer/features/reader/types';
import { useReaderStore, type ReaderSession } from '../../src/renderer/stores/use-reader-store';
import { testDocumentAdapter, type AdapterOverrides } from './document-adapter';

/**
 * The adapter a session holds before its document has rendered: it accepts the
 * reader's callbacks, resolves no annotations, has no annotation scope yet, has no
 * search paint to clear, and closes without work. Anything else throws until
 * the test stubs it; a case that lets the reader mount it supplies the calls
 * the mount makes.
 */
export function testUnrenderedAdapter(
  document: DocumentMetadata,
  overrides: AdapterOverrides = {},
): DocumentAdapter {
  return testDocumentAdapter(document.format, {
    setLocationChangeCallback: () => undefined,
    setSelectionChangeCallback: () => undefined,
    setAnnotationResolutionCallback: () => undefined,
    getAnnotationScope: () => null,
    clearSearchHighlight: () => undefined,
    close: () => Promise.resolve(),
    ...overrides,
  });
}

/** The store only ever pairs a document with the adapter for its format. */
function assertAdapterReads(adapter: DocumentAdapter, document: DocumentMetadata): void {
  if (adapter.format !== document.format) {
    throw new Error(`A ${adapter.format} adapter cannot read a ${document.format} document.`);
  }
}

/**
 * One open reader session, as the store holds it once a document has opened.
 *
 * Opening a document always yields its adapter, asset URL, media list and start
 * location together, so a test seats all of them at once. Pass `adapter` when
 * the case exercises one.
 */
export function testReaderSession(
  document: DocumentMetadata,
  overrides: Partial<Omit<ReaderSession, 'document'>> = {},
): ReaderSession {
  const session: ReaderSession = {
    document,
    adapter: testUnrenderedAdapter(document),
    assetUrl: `interleaf-media://${document.id}`,
    mediaAssets: [],
    initialLocation: null,
    ...overrides,
  };
  assertAdapterReads(session.adapter, document);
  return session;
}

/**
 * Replaces the open session's adapter with the case's own double.
 *
 * The adapter only ever exists inside an open session, so this requires one;
 * the suite's setup opens it, and the double must be for the open document's format.
 */
export function seatReaderAdapter(adapter: DocumentAdapter): void {
  const { session } = useReaderStore.getState();
  if (!session) throw new Error('The test has no open reader session to seat an adapter in.');
  assertAdapterReads(adapter, session.document);
  useReaderStore.setState({ session: { ...session, adapter } });
}
