import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { invokeChannel } from '@main/ipc/dispatcher';
import { IPC } from '@shared/constants/ipc';
import { CLIPBOARD_WRITE_TEXT_MAX_BYTES } from '@shared/schemas/clipboard';
import { ClipboardService } from '@main/clipboard/clipboard-service';
import { createSenderRule, type SenderRule } from '@main/ipc/sender-validation';
import { silentLogger as silentLog } from '../helpers/silent-logger';
import type { CloneableValue } from '@shared/models/portable';

const senderRule: SenderRule = createSenderRule({
  indexHtmlPath: '/out/renderer/index.html',
});

const allowedEvent = {
  senderFrame: { url: senderRule.allowedProductionFileUrl },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;

async function invokeClipboard(
  payload: CloneableValue,
  event: Pick<IpcMainInvokeEvent, 'senderFrame'> = allowedEvent,
) {
  const writeText = vi.fn(() => Promise.resolve());
  const clipboardService = new ClipboardService({ clipboard: { writeText } });
  const handler = (req: { readonly text: string }) => clipboardService.writeText(req.text);
  const response = await invokeChannel(IPC.clipboardWriteText, handler, payload, event, {
    senderRule,
    log: silentLog,
  });
  return { response, writeText };
}

describe('Clipboard IPC Channel (clipboard:write-text)', () => {
  it.each([
    ['ordinary text', 'A long document passage excerpt.'],
    ['an empty string', ''],
    ['exactly 2 MiB of ASCII', 'A'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES)],
    ['exactly 2 MiB of 2-byte UTF-8', 'é'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES / 2)],
    ['exactly 2 MiB of 4-byte UTF-8', '📚'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES / 4)],
  ])('writes %s through the dispatcher and returns a typed success envelope', async (_description, text) => {
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(CLIPBOARD_WRITE_TEXT_MAX_BYTES);
    const { response, writeText } = await invokeClipboard({ text });

    expect(response).toEqual({ ok: true, data: { copied: true, characterCount: text.length } });
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it.each([
    ['ASCII', 'A'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES + 1)],
    ['2-byte UTF-8 plus one ASCII character', `${'é'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES / 2)}A`],
    ['4-byte UTF-8 plus one ASCII character', `${'📚'.repeat(CLIPBOARD_WRITE_TEXT_MAX_BYTES / 4)}A`],
  ])('rejects 2 MiB + 1 byte of %s at the main boundary', async (_description, text) => {
    expect(new TextEncoder().encode(text).byteLength).toBe(CLIPBOARD_WRITE_TEXT_MAX_BYTES + 1);
    const { response, writeText } = await invokeClipboard({ text });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('validation');
      expect(response.error.message).toContain('exceeds the maximum limit');
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['missing text property', {}],
    ['non-string text', { text: 12345 }],
    ['extra unrecognized properties', { text: 'valid', extraField: true }],
    ['primitive string payload', 'naked string'],
    ['undefined payload', undefined],
  ])('rejects malformed payload (%s) with validation error and does not write', async (_description, payload) => {
    const { response, writeText } = await invokeClipboard(payload);

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('validation');
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['an unauthorized sender origin', { senderFrame: { url: 'https://evil.example.com/' } }],
    ['a null sender frame', { senderFrame: null }],
  ] as const)('rejects invocations from %s and does not write', async (_description, event) => {
    const { response, writeText } = await invokeClipboard(
      { text: 'confidential' },
      event as Pick<IpcMainInvokeEvent, 'senderFrame'>,
    );

    expect(response).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sender-rejected' }),
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('acknowledges the copy only after the asynchronous native write settles', async () => {
    let settle: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const service = new ClipboardService({ clipboard: { writeText: () => pending } });
    let acknowledged = false;
    const result = service.writeText('copied text').then((value) => {
      acknowledged = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    settle();
    await expect(result).resolves.toEqual({ copied: true, characterCount: 11 });
  });

  it('returns a typed failure envelope when the native write rejects', async () => {
    const clipboardService = new ClipboardService({
      clipboard: { writeText: () => Promise.reject(new Error('native clipboard unavailable')) },
    });
    const response = await invokeChannel(
      IPC.clipboardWriteText,
      (req: { readonly text: string }) => clipboardService.writeText(req.text),
      { text: 'copied text' },
      allowedEvent,
      { senderRule, log: silentLog },
    );

    expect(response).toMatchObject({ ok: false });
  });
});
