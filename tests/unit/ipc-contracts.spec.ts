import { describe, expect, it } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { IpcMainInvokeEvent } from 'electron';
import { invokeChannel } from '@main/ipc/dispatcher';
import { IPC } from '@shared/constants/ipc';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { ChatSession } from '@shared/types/ai';
import type { LogMeta, Logger } from '@main/logging/logger';
import { silentLogger as silentLog } from '../helpers/silent-logger';
import { createSenderRule, type SenderRule } from '@main/ipc/sender-validation';
import type { PortableValue } from '@shared/models/portable';

const senderRule: SenderRule = createSenderRule({
  indexHtmlPath: '/out/renderer/index.html',
});

const allowedEvent = {
  senderFrame: { url: senderRule.allowedProductionFileUrl },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;

const rejectedEvent = {
  senderFrame: { url: 'https://evil.example.com/' },
} as Pick<IpcMainInvokeEvent, 'senderFrame'>;

describe('IPC contract enforcement', () => {
  it('accepts a valid settings payload and returns the stored result', async () => {
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      (next) => next,
      DEFAULT_APP_SETTINGS,
      allowedEvent,
      { senderRule, log: silentLog }
    );
    expect(envelope).toEqual({ ok: true, data: DEFAULT_APP_SETTINGS });
  });

  it('rejects malformed payloads with a validation code', async () => {
    const invalid = {
      version: 1,
      appearance: { palette: 'neon-green' },
      agent: { defaultExecutionMode: 'isolated-worktree' },
    };
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      (next) => next,
      invalid,
      allowedEvent,
      { senderRule, log: silentLog }
    );
    expect(envelope).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each(['active-env', 'native-restricted'])('rejects unsafe persisted default %s', async (mode) => {
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      (next) => next,
      {
        ...DEFAULT_APP_SETTINGS,
        agent: { defaultExecutionMode: mode },
      },
      allowedEvent,
      { senderRule, log: silentLog }
    );
    expect(envelope).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  describe('chat:get-session document scoping', () => {
    const ownedSession: ChatSession = {
      id: 'session-1',
      documentId: 'doc-owner',
      documentHash: 'hash-owner',
      title: 'Owned conversation',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
      reasoningEffort: null,
      messageCount: 2,
      previewText: null,
      isArchived: false,
      compactedThroughOrdinal: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
    };

    it('accepts a request carrying both the session and document ID', async () => {
      const envelope = await invokeChannel(
        IPC.chatGetSession,
        (req) => (req.documentId === ownedSession.documentId ? ownedSession : null),
        { sessionId: 'session-1', documentId: 'doc-owner' },
        allowedEvent,
        { senderRule, log: silentLog }
      );
      expect(envelope).toEqual({ ok: true, data: ownedSession });
    });

    it('rejects a request that omits the document ID before the handler runs', async () => {
      const calls: PortableValue[] = [];
      const envelope = await invokeChannel(
        IPC.chatGetSession,
        (req) => { calls.push(req); return null; },
        { sessionId: 'session-1' },
        allowedEvent,
        { senderRule, log: silentLog }
      );
      expect(envelope).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(calls).toHaveLength(0);
    });

    it('rejects an unknown extra field rather than stripping it', async () => {
      const envelope = await invokeChannel(
        IPC.chatGetSession,
        () => null,
        { sessionId: 'session-1', documentId: 'doc-1', documentid: 'doc-2' },
        allowedEvent,
        { senderRule, log: silentLog }
      );
      expect(envelope).toMatchObject({ ok: false, error: { code: 'validation' } });
    });

    it('forwards a mismatched document ID so main can refuse the lookup', async () => {
      // The contract cannot know ownership; it must hand main the claimed
      // document so the scoped query returns null instead of another
      // document's session.
      const received: { sessionId: string; documentId: string }[] = [];
      const envelope = await invokeChannel(
        IPC.chatGetSession,
        (req) => {
          received.push(req);
          return req.documentId === ownedSession.documentId ? ownedSession : null;
        },
        { sessionId: 'session-1', documentId: 'doc-attacker' },
        allowedEvent,
        { senderRule, log: silentLog }
      );
      expect(received).toEqual([{ sessionId: 'session-1', documentId: 'doc-attacker' }]);
      expect(envelope).toEqual({ ok: true, data: null });
    });
  });

  it('rejects invocations from untrusted senders before validation', async () => {
    const updateCalls: AppSettings[] = [];
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      (next) => {
        updateCalls.push(next);
        return next;
      },
      DEFAULT_APP_SETTINGS,
      rejectedEvent,
      { senderRule, log: silentLog }
    );
    expect(envelope).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(updateCalls).toHaveLength(0);
  });

  it('maps handler crashes to internal errors and keeps raw exception messages out of logged metadata', async () => {
    const loggedErrors: LogMeta[] = [];
    const capturingLog: Logger = {
      ...silentLog,
      error: (_msg, meta) => { if (meta) loggedErrors.push(meta); },
    };
    const rawSecretMessage = 'DATABASE_PASSWORD=supersecret-token-123456 connection failed at /var/secrets/db.key';
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      () => {
        throw new Error(rawSecretMessage);
      },
      DEFAULT_APP_SETTINGS,
      allowedEvent,
      { senderRule, log: capturingLog }
    );
    expect(envelope).toMatchObject({ ok: false, error: { code: 'internal' } });
    if (!envelope.ok) {
      expect(envelope.error.message).not.toContain('supersecret-token');
      expect(envelope.error.message).not.toContain('DATABASE_PASSWORD');
      expect(envelope.error.message).toMatch(/Diagnostic ID:/);
    }
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]?.channel).toBe(IPC.settingsUpdate);
    expect(typeof loggedErrors[0]?.diagnosticId).toBe('string');
    expect(loggedErrors[0]?.errorType).toBe('Error');
    expect(loggedErrors[0]).not.toHaveProperty('errorMessage');
    expect(JSON.stringify(loggedErrors[0])).not.toContain('supersecret-token');
    expect(JSON.stringify(loggedErrors[0])).not.toContain('DATABASE_PASSWORD');
  });
  it.each([
    ['mode-resolution-failed', 'Cannot use Isolated Worktree mode because the selected target is not a Git repository.'],
    ['media-forbidden', 'Assets must be staged beneath an application-managed media root.'],
  ] as const)('preserves typed non-validation %s error payload across IPC boundary', async (code, message) => {
    const envelope = await invokeChannel(
      IPC.settingsUpdate,
      () => {
        throw new InterleafError(code, message);
      },
      DEFAULT_APP_SETTINGS,
      allowedEvent,
      { senderRule, log: silentLog }
    );
    expect(envelope).toEqual({
      ok: false,
      error: {
        __interleafError: true,
        code,
        message,
      },
    });
  });
});
