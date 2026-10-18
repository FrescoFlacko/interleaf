import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/constants/ipc';
import { registerIpcHandlers, type IpcMainLike } from '@main/ipc/dispatcher';
import type { AgentService } from '@main/agents/agent-service';
import type { ChatService } from '@main/ai/chat-service';
import type { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import type { LibraryService } from '@main/library/library-service';
import type { OpenFilesRuntime } from '@main/open-files/open-file-routing';
import type { DocumentServices } from '@main/open-files/open-file-store';
import { makeIpcDeps, testSenderRule } from '../helpers/ipc-deps';
import { unstubbed } from '../helpers/unstubbed';

const reader = {
  senderFrame: { url: testSenderRule.allowedProductionFileUrl },
  sender: { id: 3 },
} as object as IpcMainInvokeEvent;
const hostile = { senderFrame: { url: 'https://evil.example/' } } as object as IpcMainInvokeEvent;

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';
type Handler = Parameters<IpcMainLike['handle']>[1];
type Envelope = { readonly ok: boolean; readonly data?: object | string | null; readonly error?: { readonly code: string; readonly message: string } };

/** Records which service set answered: each answer carries the set's name in place of real data. */
function services(name: string): DocumentServices {
  return {
    library: unstubbed<LibraryService>(`${name}.library`, {
      openDocument: vi.fn(() => Promise.resolve({ document: { id: name } } as never)),
    }),
    annotations: unstubbed<AnnotationRepository>(`${name}.annotations`, { list: vi.fn(() => [name] as never) }),
    search: unstubbed(`${name}.search`),
    chat: unstubbed<ChatService>(`${name}.chat`, {
      listSessions: vi.fn(() => [name] as never),
      cancel: vi.fn(() => Promise.resolve()),
      cancelForDocument: vi.fn(() => Promise.resolve()),
    }),
  };
}

function setup() {
  const library = services('library');
  const opened = services('opened');
  const openFiles: OpenFilesRuntime = {
    owns: vi.fn((id: string) => id === 'visiting' || id === 'closed'),
    forDocument: vi.fn((id: string) => {
      if (id === 'closed') throw new Error('This document is no longer open.');
      return id === 'visiting' ? opened : null;
    }),
    forSession: vi.fn(() => null),
    close: vi.fn(() => Promise.resolve()),
    closeAll: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    open: vi.fn((filePath: string) => Promise.resolve({ id: 'visiting', title: filePath } as never)),
    chooseFile: vi.fn(() => Promise.resolve('/docs/chosen.md')),
    takePendingPath: vi.fn(() => null),
  };
  const agent = unstubbed<AgentService>('agent', { startSession: vi.fn(), listSessions: vi.fn(() => ['agent'] as never) });
  const handlers = new Map<string, Handler>();
  const deps = makeIpcDeps({ ...library, openFiles, agent });
  registerIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } }, deps);
  const invoke = async (channel: string, payload?: object, event = reader): Promise<Envelope> =>
    (await handlers.get(channel)!(event, payload as never)) as Envelope;
  return { invoke, library, opened, openFiles, agent };
}

describe('open-file IPC routing', () => {
  it('opens through main\'s own dialog and takes no path from the renderer', async () => {
    const { invoke, openFiles } = setup();
    await expect(invoke(IPC.filesOpenDialog)).resolves.toMatchObject({ ok: true, data: { id: 'visiting', title: '/docs/chosen.md' } });
    expect(openFiles.open).toHaveBeenCalledWith('/docs/chosen.md');
    const smuggled = await invoke(IPC.filesOpenDialog, { path: '/etc/passwd' });
    expect(smuggled.ok).toBe(false);
    expect(await invoke(IPC.filesOpenPending, { path: '/etc/passwd' })).toMatchObject({ ok: false });
    expect(await invoke(IPC.filesOpenPending)).toMatchObject({ ok: true, data: null });
    expect(await invoke(IPC.filesOpenDialog, undefined, hostile)).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(openFiles.open).toHaveBeenCalledTimes(1);
  });

  it('answers an opened file from its own services and a library document from the library', async () => {
    const { invoke, library, opened } = setup();
    expect(await invoke(IPC.annotationsList, { documentId: 'visiting' })).toMatchObject({ data: ['opened'] });
    expect(await invoke(IPC.annotationsList, { documentId: 'kept' })).toMatchObject({ data: ['library'] });
    expect(await invoke(IPC.chatListSessions, { documentId: 'visiting' })).toMatchObject({ data: ['opened'] });
    expect(library.chat.listSessions).not.toHaveBeenCalled();
    expect(opened.chat.listSessions).toHaveBeenCalledWith('visiting');
    expect(await invoke(IPC.annotationsList, { documentId: 'closed' })).toMatchObject({ ok: false });
    expect(library.annotations.list).toHaveBeenCalledTimes(1);
  });

  it('closes open files before a library document opens, and closes an opened file by disposal', async () => {
    const { invoke, library, openFiles } = setup();
    expect(await invoke(IPC.libraryOpenDocument, { id: 'kept' })).toMatchObject({ data: { document: { id: 'library' } } });
    expect(openFiles.closeAll).toHaveBeenCalledTimes(1);
    expect(await invoke(IPC.libraryOpenDocument, { id: 'visiting' })).toMatchObject({ data: { document: { id: 'opened' } } });
    await invoke(IPC.libraryCloseDocument, { id: 'visiting' });
    expect(openFiles.close).toHaveBeenCalledWith('visiting');
    expect(library.chat.cancelForDocument).not.toHaveBeenCalled();
  });

  it('keeps Agent Mode to library documents and offers cancellation to both chats', async () => {
    const { invoke, agent, library, openFiles } = setup();
    const run = { documentId: 'visiting', profileId: 'codex', workingDirectoryHandle: 'handle', executionMode: 'auto-isolated', prompt: 'p' };
    expect(await invoke(IPC.agentStartSession, run)).toMatchObject({ ok: false, error: { message: 'Agent Mode works with documents in your library.' } });
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(await invoke(IPC.agentListSessions, { documentId: 'visiting' })).toMatchObject({ data: [] });
    expect(await invoke(IPC.agentListSessions, { documentId: 'kept' })).toMatchObject({ data: ['agent'] });
    expect(await invoke(IPC.chatCancel, { requestId: REQUEST_ID })).toMatchObject({ ok: true });
    expect(library.chat.cancel).toHaveBeenCalledWith(REQUEST_ID, 3);
    expect(openFiles.cancel).toHaveBeenCalledWith(REQUEST_ID, 3);
  });
});
