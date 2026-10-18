import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/constants/ipc';
import { invokeChannel } from '@main/ipc/dispatcher';
import { openExternalFromDocument } from '@main/app/open-external';
import { createSenderRule, type SenderRule } from '@main/ipc/sender-validation';
import {
  MAX_EXTERNAL_URL_LENGTH,
  parseExternalHttpUrl,
} from '@shared/schemas/external-link';
import { createInterleafApi, type PreloadIpc } from '../../src/preload/index';
import type { Logger } from '@main/logging/logger';
import type { CloneableValue } from '@shared/models/portable';
import type { LogMeta } from '@main/logging/logger';

/**
 * The one way a document's link leaves the application.
 *
 * Every assertion here runs against the real boundary — the shared parser, the
 * dispatcher's schema and sender check, and the preload bridge — with the
 * desktop handoff injected. No browser is ever launched.
 */

type LogLine = { readonly message: string; readonly meta?: LogMeta };

function recordingLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record = (message: string, meta?: LogMeta) => {
    lines.push(meta === undefined ? { message } : { message, meta });
  };
  return {
    lines,
    log: { debug: record, info: record, warn: record, error: record },
  };
}

const senderRule: SenderRule = createSenderRule({
  indexHtmlPath: '/out/renderer/index.html',
  devUrl: 'http://localhost:5173',
});

const allowedEvent = {
  senderFrame: { url: senderRule.allowedProductionFileUrl },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;

const hostileEvent = {
  senderFrame: { url: 'https://evil.example/' },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;

async function invokeOpenExternal(
  payload: CloneableValue,
  options: {
    readonly openExternal?: (url: string) => Promise<void>;
    readonly requireConfirmation?: () => boolean;
    readonly confirmExternalLink?: (url: string) => Promise<boolean>;
    readonly event?: Pick<IpcMainInvokeEvent, 'senderFrame'>;
    readonly log?: Logger;
  } = {}
) {
  const log = options.log ?? recordingLog().log;
  return invokeChannel(
    IPC.appOpenExternal,
    (req) => openExternalFromDocument(req, {
      openExternal: () => Promise.resolve(),
      requireConfirmation: () => false,
      confirmExternalLink: () => Promise.reject(new Error('The test did not stub confirmExternalLink.')),
      ...options,
      log,
    }),
    payload,
    options.event ?? allowedEvent,
    { senderRule, log }
  );
}

describe('External link target policy', () => {
  it('accepts ordinary absolute http and https document links', () => {
    expect(parseExternalHttpUrl('https://www.justinmklam.com/posts/2026/02/split/')).toBe(
      'https://www.justinmklam.com/posts/2026/02/split/'
    );
    expect(parseExternalHttpUrl('http://example.org')).toBe('http://example.org/');
    expect(parseExternalHttpUrl('  https://example.org/a?b=c#d  ')).toBe(
      'https://example.org/a?b=c#d'
    );
  });

  it('refuses everything that is not a plain external link', () => {
    for (const target of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'mailto:someone@example.com',
      'interleaf-media://doc/asset',
      'about:blank',
      '#section-two',
      '/relative/path',
      'example.org/no-scheme',
      '',
      '   ',
      'https://',
      'https:// example.org/space',
      'https://example.org/\nSet-Cookie: x',
      'https://example.org/\u0000',
      `https://example.org/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`,
      42,
      null,
      undefined,
      { url: 'https://example.org' },
    ]) {
      expect(parseExternalHttpUrl(target)).toBeNull();
    }
  });

  it('refuses links carrying embedded credentials', () => {
    expect(parseExternalHttpUrl('https://alice:s3cret@example.org/')).toBeNull();
    expect(parseExternalHttpUrl('https://alice@example.org/')).toBeNull();
  });
});

describe('app:open-external main boundary', () => {
  it('hands one canonical link to the desktop and reports it opened', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const response = await invokeOpenExternal(
      { url: '  https://example.org/posts/split-keyboards  ' },
      { openExternal }
    );

    expect(response).toEqual({ ok: true, data: { opened: true } });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://example.org/posts/split-keyboards'
    );
  });

  it('re-validates the target instead of trusting the renderer that sent it', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://alice:s3cret@example.org/',
      'example.org/no-scheme',
    ]) {
      const response = await invokeOpenExternal({ url }, { openExternal });
      expect(response).toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a request from an unauthorized sender before any target is considered', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const response = await invokeOpenExternal(
      { url: 'https://example.org/' },
      { openExternal, event: hostileEvent }
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized payloads at the schema', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    for (const payload of [
      undefined,
      {},
      { url: 'https://example.org/', extra: true },
      { url: 12 },
      { url: `https://example.org/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}` },
    ]) {
      const response = await invokeOpenExternal(payload, { openExternal });
      expect(response).toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports a refusal by the operating system as "not opened" rather than a failure', async () => {
    const response = await invokeOpenExternal(
      { url: 'https://example.org/' },
      { openExternal: () => Promise.reject(new Error('no handler')) }
    );

    expect(response).toEqual({ ok: true, data: { opened: false } });
  });

  it('records only a generic outcome, with nothing derived from the link', async () => {
    const secret = 'https://example.org/share/TOKEN-9f3a?q=what+the+reader+searched';
    const { log, lines } = recordingLog();
    await invokeOpenExternal({ url: secret }, { openExternal: () => Promise.resolve(), log });
    await invokeOpenExternal(
      { url: secret },
      { openExternal: () => Promise.reject(new Error('no handler')), log }
    );

    expect(lines).toHaveLength(2);
    const written = JSON.stringify(lines);
    // Not the URL, not its query, and not even the scheme or host survive.
    expect(written).not.toContain('TOKEN-9f3a');
    expect(written).not.toContain('what+the+reader+searched');
    expect(written).not.toContain('example.org');
    expect(written).not.toContain('https:');
    expect(lines[0]).toMatchObject({ message: 'Opened an external link' });
    expect(lines[1]).toMatchObject({ message: 'The operating system refused an external link' });
  });
});

/**
 * The optional Privacy preference. Confirmation is taken in main, on the target
 * main itself re-derived, and declining must open nothing.
 */
describe('app:open-external confirmation preference', () => {
  it('opens in one click while the preference is off', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const confirmExternalLink = vi.fn(() => Promise.resolve(true));
    const response = await invokeOpenExternal(
      { url: 'https://example.org/a' },
      { openExternal, confirmExternalLink, requireConfirmation: () => false }
    );

    expect(response).toEqual({ ok: true, data: { opened: true } });
    expect(confirmExternalLink).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.org/a');
  });

  it('confirms the canonical target, not the string the renderer sent', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const confirmExternalLink = vi.fn(() => Promise.resolve(true));
    const response = await invokeOpenExternal(
      { url: '  https://example.org/posts/split-keyboards  ' },
      { openExternal, confirmExternalLink, requireConfirmation: () => true }
    );

    expect(response).toEqual({ ok: true, data: { opened: true } });
    expect(confirmExternalLink).toHaveBeenCalledExactlyOnceWith(
      'https://example.org/posts/split-keyboards'
    );
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://example.org/posts/split-keyboards'
    );
  });

  it('opens nothing when the reader declines', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const response = await invokeOpenExternal(
      { url: 'https://example.org/a' },
      {
        openExternal,
        confirmExternalLink: () => Promise.resolve(false),
        requireConfirmation: () => true,
      }
    );

    expect(response).toEqual({ ok: true, data: { opened: false } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects an invalid target before anything is shown to confirm', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const confirmExternalLink = vi.fn(() => Promise.resolve(true));
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://alice:s3cret@example.org/']) {
      const response = await invokeOpenExternal(
        { url },
        { openExternal, confirmExternalLink, requireConfirmation: () => true }
      );
      expect(response).toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    expect(confirmExternalLink).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reads the preference per request, so a change applies to the next click', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const confirmExternalLink = vi.fn(() => Promise.resolve(true));
    let confirmationRequired = false;
    const options = {
      openExternal,
      confirmExternalLink,
      requireConfirmation: () => confirmationRequired,
    };

    await invokeOpenExternal({ url: 'https://example.org/a' }, options);
    expect(confirmExternalLink).not.toHaveBeenCalled();
    confirmationRequired = true;
    await invokeOpenExternal({ url: 'https://example.org/a' }, options);
    expect(confirmExternalLink).toHaveBeenCalledOnce();
  });

  it('records a declined link without anything derived from its target', async () => {
    const secret = 'https://example.org/share/TOKEN-9f3a?q=what+the+reader+searched';
    const { log, lines } = recordingLog();
    await invokeOpenExternal(
      { url: secret },
      {
        openExternal: () => Promise.resolve(),
        confirmExternalLink: () => Promise.resolve(false),
        requireConfirmation: () => true,
        log,
      }
    );

    expect(lines).toEqual([{ message: 'An external link was not confirmed' }]);
    const written = JSON.stringify(lines);
    expect(written).not.toContain('TOKEN-9f3a');
    expect(written).not.toContain('what+the+reader+searched');
    expect(written).not.toContain('example.org');
    expect(written).not.toContain('https:');
  });
});

describe('app.openExternal preload bridge', () => {
  function bridge(reply: CloneableValue = { opened: true }) {
    const calls: { channel: string; payload: CloneableValue }[] = [];
    const ipc: PreloadIpc = {
      invoke: (channel, payload) => {
        calls.push({ channel, payload });
        return Promise.resolve({ ok: true, data: reply });
      },
      on: () => undefined,
      removeListener: () => undefined,
      send: () => undefined,
    };
    return { api: createInterleafApi(ipc, { getPathForFile: (file) => `/tmp/${file.name}` }), calls };
  }

  it('forwards the canonical target on the declared channel', async () => {
    const { api, calls } = bridge();
    await expect(api.app.openExternal('  https://example.org/a  ')).resolves.toEqual({
      opened: true,
    });
    expect(calls).toEqual([
      { channel: IPC.appOpenExternal, payload: { url: 'https://example.org/a' } },
    ]);
  });

  it('refuses a non-http target without touching the channel', async () => {
    const { api, calls } = bridge();
    await expect(api.app.openExternal('javascript:alert(1)')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(api.app.openExternal('#anchor')).rejects.toMatchObject({ code: 'validation' });
    expect(calls).toEqual([]);
  });

  it('rejects a malformed reply rather than passing it to the renderer', async () => {
    const { api } = bridge({ opened: 'yes', target: '/Users/alice/private' });
    await expect(api.app.openExternal('https://example.org/')).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
