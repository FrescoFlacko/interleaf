import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/constants/ipc';
import { registerIpcHandlers, type IpcDispatcherDeps, type IpcMainLike } from '@main/ipc/dispatcher';
import { makeIpcDeps, testSenderRule } from '../helpers/ipc-deps';

const reader = {
  senderFrame: { url: testSenderRule.allowedProductionFileUrl },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;
const hostile = { senderFrame: { url: 'https://evil.example/' } } as Pick<IpcMainInvokeEvent, 'senderFrame'>;

type Handler = Parameters<IpcMainLike['handle']>[1];

function channelHandler(mermaid: IpcDispatcherDeps['mermaid']): Handler {
  const registered: Handler[] = [];
  const deps = makeIpcDeps({ mermaid });
  registerIpcHandlers(
    {
      handle: (channel, listener) => {
        if (channel === IPC.readerRenderMermaid) registered.push(listener);
      },
    },
    deps
  );
  const handler = registered[0];
  if (handler === undefined) throw new Error('diagram channel was never registered');
  return handler;
}

describe('reader:render-mermaid channel', () => {
  it('answers a rendered diagram from the service', async () => {
    const render = vi.fn().mockResolvedValue({
      status: 'rendered',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      width: 10,
      height: 10,
    });
    const handler = channelHandler({ render });

    const response = await handler(reader, {
      source: 'flowchart TD\n A-->B',
      appearance: 'dark',
    });

    expect(render).toHaveBeenCalledWith({ source: 'flowchart TD\n A-->B', appearance: 'dark' });
    expect(response).toMatchObject({ ok: true, data: { status: 'rendered' } });
  });

  it('rejects a malformed request without reaching the service', async () => {
    const render = vi.fn();
    const handler = channelHandler({ render });

    expect(
      await handler(reader, { source: 'flowchart TD', appearance: 'light', securityLevel: 'loose' })
    ).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await handler(reader, 'flowchart TD')).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects a request from a frame that is not the reader', async () => {
    const render = vi.fn();
    const handler = channelHandler({ render });

    expect(
      await handler(hostile, { source: 'flowchart TD\n A-->B', appearance: 'light' })
    ).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(render).not.toHaveBeenCalled();
  });
});
