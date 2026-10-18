import { describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import { createSenderRule } from '@main/ipc/sender-validation';
import { invokeChannel } from '@main/ipc/dispatcher';
import { silentLogger as silentLog } from '../helpers/silent-logger';

const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html', devUrl: 'http://localhost:5173' });
const validEvent = { senderFrame: { url: senderRule.allowedProductionFileUrl } } as never;

describe('custom agent IPC contracts', () => {
  it('rejects renderer paths and shell-shaped payloads before main handlers run', () => {
    const schema = ipcRequestSchemas[IPC.agentCreateCustomProfile];
    expect(schema.safeParse({
      name: 'malicious', executableHandle: 'not-a-main-handle', executablePath: '/etc/passwd',
      argvTemplate: ['sh -c "{{promptFile}}"'], promptDeliveryMode: 'temp-file', stdoutParsingMode: 'text',
    }).success).toBe(false);
    expect(ipcRequestSchemas[IPC.agentUpdateCustomProfile].safeParse({ id: '/etc/passwd', name: 'bad' }).success).toBe(false);
    expect(ipcRequestSchemas[IPC.agentDeleteCustomProfile].safeParse({ id: '../../custom-profile' }).success).toBe(false);
  });

  it('returns a typed validation envelope and never calls a handler for a rogue path', async () => {
    const handler = vi.fn(() => Promise.resolve(undefined));
    const envelope = await invokeChannel(
      IPC.agentCreateCustomProfile,
      handler as never,
      { name: 'bad', executableHandle: 'abc', executablePath: '/tmp/escape', argvTemplate: [], promptDeliveryMode: 'stdin', stdoutParsingMode: 'none' },
      validEvent,
      { senderRule, log: silentLog },
    );
    expect(envelope).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(handler).not.toHaveBeenCalled();
  });
});
