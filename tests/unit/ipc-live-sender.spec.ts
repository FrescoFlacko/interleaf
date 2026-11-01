import { describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { registerIpcHandlers, type IpcDispatcherDeps, type IpcMainLike } from '@main/ipc/dispatcher';
import type { AgentService } from '@main/agents/agent-service';
import { makeIpcDeps, testSenderRule } from '../helpers/ipc-deps';
import { unstubbed } from '../helpers/unstubbed';

type Handler = Parameters<IpcMainLike['handle']>[1];

const senderFrame = { url: testSenderRule.allowedProductionFileUrl };

/** An allowed frame whose web contents is present, as Electron delivers an invoke. */
const liveEvent = {
  senderFrame,
  sender: {
    id: 42,
    send: () => undefined,
    isDestroyed: () => false,
    once: () => undefined,
    removeListener: () => undefined,
  },
};

/** An allowed frame that arrives without its web contents. */
const senderlessEvent = { senderFrame };

function handlerFor(channel: string, deps: IpcDispatcherDeps): Handler {
  let found: Handler | undefined;
  registerIpcHandlers({ handle: (name, listener) => { if (name === channel) found = listener; } }, deps);
  if (found === undefined) throw new Error(`${channel} was never registered`);
  return found;
}

describe('handlers that need the invoking renderer', () => {
  it.each([
    [IPC.agentStopSession, { sessionId: 'session-1' }, 'Agent cancellation requires a live renderer sender.'],
    [IPC.agentResumeSession, { sessionId: 'session-1', prompt: 'continue' }, 'Agent streaming requires a live renderer sender.'],
    [IPC.agentCopyResult, { sessionId: 'session-1' }, 'Clipboard copy requires a live renderer sender.'],
    [IPC.agentClaimSession, { sessionId: 'session-1' }, 'Claiming an agent session requires a live renderer sender.'],
    [IPC.agentGetEnvironmentReview, { sessionId: 'session-1' }, 'Reading an agent review requires a live renderer sender.'],
    [IPC.agentApplyChanges, { sessionId: 'session-1' }, 'Applying changes requires a live renderer sender.'],
    [IPC.agentDiscardSandbox, { sessionId: 'session-1' }, 'Discarding a sandbox requires a live renderer sender.'],
    [IPC.agentExportPatch, { sessionId: 'session-1' }, 'Exporting a patch requires a live renderer sender.'],
    [IPC.agentOpenFolder, { sessionId: 'session-1' }, 'Opening an agent folder requires a live renderer sender.'],
  ])('%s rejects a senderless invoke with its own typed error and never reaches the service', async (channel, payload, message) => {
    const agent = unstubbed<AgentService>('agent');
    const response = await handlerFor(channel, makeIpcDeps({ agent }))(senderlessEvent, payload);
    expect(response).toEqual({ ok: false, error: expect.objectContaining({ code: 'sender-rejected', message }) });
  });

  it('chat:cancel rejects a senderless invoke before routing the cancellation', async () => {
    const response = await handlerFor(IPC.chatCancel, makeIpcDeps())(senderlessEvent, { requestId: '00000000-0000-4000-8000-000000000001' });
    expect(response).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sender-rejected', message: 'Chat cancellation requires a live renderer sender.' }),
    });
  });

  it('binds the action to the invoking renderer when it is live', async () => {
    const stopSession = vi.fn(() => Promise.resolve());
    const openFolder = vi.fn(() => Promise.resolve({ opened: true as const }));
    const agent = unstubbed<AgentService>('agent', { stopSession, openFolder });
    const deps = makeIpcDeps({ agent });

    expect(await handlerFor(IPC.agentStopSession, deps)(liveEvent, { sessionId: 'session-1' })).toEqual({ ok: true, data: undefined });
    expect(stopSession).toHaveBeenCalledWith('session-1', 42);
    expect(await handlerFor(IPC.agentOpenFolder, deps)(liveEvent, { sessionId: 'session-1' })).toMatchObject({ ok: true });
    expect(openFolder).toHaveBeenCalledWith('session-1', 42);
  });
});
