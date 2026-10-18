// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { ChatStoreContext, useChatStoreApi, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { useOwnedChatStore } from '../../src/renderer/stores/use-owned-chat-store';
import { stubBridge } from '../helpers/interleaf-api';

const testDocument: DocumentMetadata = {
  id: 'doc-owned',
  title: 'Owned Controller',
  author: 'Test Author',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-owned',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
  source: null,
};

/** The stream listeners currently subscribed through the bridge. */
const listeners = new Set<(event: ChatStreamEvent) => void>();

beforeEach(() => {
  listeners.clear();
  stubBridge({
    ai: { listProviders: vi.fn(() => Promise.resolve([])) },
    chat: {
      listSessions: vi.fn(() => Promise.resolve([])),
      onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }),
    },
  });
});

/** Provides the owned controller as `App` does, and hands it to the test. */
function OwnedChat({ onStore }: { readonly onStore: (store: ChatStore) => void }): ReactNode {
  const store = useOwnedChatStore();
  return (
    <ChatStoreContext.Provider value={store}>
      <ReportStore onStore={onStore} />
    </ChatStoreContext.Provider>
  );
}

function ReportStore({ onStore }: { readonly onStore: (store: ChatStore) => void }): null {
  onStore(useChatStoreApi());
  return null;
}

/** Mounts under StrictMode, lets any deferred work settle, and opens a document. */
async function mountWorkingController() {
  const provided: { store: ChatStore | null } = { store: null };
  const view = render(<StrictMode><OwnedChat onStore={(store) => { provided.store = store; }} /></StrictMode>);
  await act(async () => { await Promise.resolve(); });
  const { store } = provided;
  if (store === null) throw new Error('No chat controller was provided.');
  await act(async () => { await store.getState().initializeDocument(testDocument); });
  return { store, view };
}

const lateEvent: ChatStreamEvent = {
  type: 'error',
  documentId: testDocument.id,
  sessionId: 'session-late',
  messageId: 'message-late',
  requestId: '550e8400-e29b-41d4-a716-446655440000',
  error: { __interleafError: true, code: 'internal', message: 'late' },
};

describe('the app-owned chat controller', () => {
  it('survives StrictMode\'s replayed mount with exactly one stream subscription', async () => {
    const { store, view } = await mountWorkingController();
    expect(store.getState().activeDocument).toEqual({ id: testDocument.id, fileHash: testDocument.fileHash });
    expect(store.getState().isLoading).toBe(false);
    expect(listeners.size).toBe(1);
    view.unmount();
  });

  it('unsubscribes on a real unmount and ignores events that arrive afterwards', async () => {
    const { store, view } = await mountWorkingController();
    const [listener] = [...listeners];
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(listeners.size).toBe(0);
    const before = store.getState();
    listener?.(lateEvent);
    expect(store.getState()).toBe(before);
  });

  it('gives a fresh mount its own working controller', async () => {
    const first = await mountWorkingController();
    first.view.unmount();
    await act(async () => { await Promise.resolve(); });
    const second = await mountWorkingController();
    expect(second.store).not.toBe(first.store);
    expect(second.store.getState().activeDocument?.id).toBe(testDocument.id);
    expect(listeners.size).toBe(1);
    second.view.unmount();
  });
});
