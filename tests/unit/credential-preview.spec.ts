import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_KEY_PREVIEW_PREFIX,
  deriveOpenRouterKeyPreview,
  formatOpenRouterKeyPreview,
  openRouterKeyPreviewSchema,
  parseOpenRouterKeyPreview,
} from '@shared/schemas/credential-preview';
import { clearOpenRouterCredential, readOpenRouterCredentialStatus } from '../../src/main/ai/openrouter-credential-status';
import { InterleafError } from '@shared/errors/interleaf-error';
import { createInterleafApi, type PreloadIpc } from '../../src/preload/index';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import { registerIpcHandlers, type IpcMainLike } from '../../src/main/ipc/dispatcher';
import { rejectionOf } from '../helpers/errors';
import { makeIpcDeps } from '../helpers/ipc-deps';
import { unstubbed } from '../helpers/unstubbed';
import type { ChatService } from '../../src/main/ai/chat-service';
import type { CredentialVault } from '../../src/main/ai/credential-vault';
import { createSenderRule } from '../../src/main/ipc/sender-validation';
import { UNCONFIGURED_CREDENTIAL_STATUS, USABLE_CREDENTIAL_STORAGE } from '../helpers/credential-status';
import type { CloneableValue } from '@shared/models/portable';

const VALID_KEY = 'sk-or-v1-0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop';

describe('OpenRouter masked key preview', () => {
  it('projects only the fixed prefix and the last four characters', () => {
    const preview = deriveOpenRouterKeyPreview(VALID_KEY);
    expect(preview).toEqual({ prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop' });
    // Nothing derived from the key may reconstruct any part of the secret
    // beyond those four characters.
    const rendered = formatOpenRouterKeyPreview(preview!);
    expect(rendered).toContain('mnop');
    expect(VALID_KEY).not.toContain(rendered);
    expect(rendered).not.toContain('0123456789');
  });

  it('fails closed on anything that is not a well-formed key', () => {
    for (const malformed of ['', 'not-a-key', 'sk-or-v1-', 'sk-or-v1-ab', VALID_KEY.replace('sk-or', 'sk-xx'), null, undefined, 42, {}]) {
      expect(deriveOpenRouterKeyPreview(malformed)).toBeNull();
    }
  });

  it('re-validates a preview crossing the boundary and rejects extra fields', () => {
    expect(parseOpenRouterKeyPreview({ prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop' }))
      .toEqual({ prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop' });
    expect(parseOpenRouterKeyPreview(null)).toBeNull();
    expect(parseOpenRouterKeyPreview({ prefix: 'sk-or-v1', lastFour: 'no' })).toBeNull();
    expect(parseOpenRouterKeyPreview({ prefix: 'other', lastFour: 'mnop' })).toBeNull();
    expect(openRouterKeyPreviewSchema.safeParse({ prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop', raw: VALID_KEY }).success).toBe(false);
  });
});

describe('main-side OpenRouter credential status', () => {
  it('reports an unconfigured vault without reading the key at all', async () => {
    const getOpenRouterKey = (): Promise<string | null> => Promise.reject(new Error('must not read'));
    await expect(readOpenRouterCredentialStatus({
      hasOpenRouterKey: () => Promise.resolve(false),
      getOpenRouterKey,
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).resolves.toEqual(UNCONFIGURED_CREDENTIAL_STATUS);
  });

  it('returns the masked projection for a configured vault', async () => {
    await expect(readOpenRouterCredentialStatus({
      hasOpenRouterKey: () => Promise.resolve(true),
      getOpenRouterKey: () => Promise.resolve(VALID_KEY),
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).resolves.toEqual({
      configured: true,
      keyPreview: { prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop' },
      storageBackend: USABLE_CREDENTIAL_STORAGE,
    });
  });

  it('stays configured but preview-less when decryption fails or returns junk', async () => {
    await expect(readOpenRouterCredentialStatus({
      hasOpenRouterKey: () => Promise.resolve(true),
      getOpenRouterKey: () => Promise.reject(new Error('safeStorage unavailable')),
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).resolves.toEqual({ configured: true, keyPreview: null, storageBackend: USABLE_CREDENTIAL_STORAGE });
    await expect(readOpenRouterCredentialStatus({
      hasOpenRouterKey: () => Promise.resolve(true),
      getOpenRouterKey: () => Promise.resolve('corrupted'),
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).resolves.toEqual({ configured: true, keyPreview: null, storageBackend: USABLE_CREDENTIAL_STORAGE });
  });
});

describe('main-side OpenRouter credential removal', () => {
  it('deletes without ever decrypting the credential it removes', async () => {
    let cleared = false;
    let stored = true;
    const vault = {
      hasOpenRouterKey: () => Promise.resolve(stored),
      // Removing an undecryptable ciphertext is the whole point: any read here
      // would reintroduce the failure this operation exists to route around.
      getOpenRouterKey: () => Promise.reject(new Error('must not read')),
      clearOpenRouterKey: () => { cleared = true; stored = false; return Promise.resolve(); },
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    };
    await expect(clearOpenRouterCredential(vault)).resolves.toEqual(UNCONFIGURED_CREDENTIAL_STATUS);
    expect(cleared).toBe(true);
  });

  it('reports failure rather than an unconfigured state when the key survives', async () => {
    await expect(clearOpenRouterCredential({
      hasOpenRouterKey: () => Promise.resolve(true),
      clearOpenRouterKey: () => Promise.resolve(),
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).rejects.toMatchObject({ code: 'internal' });
  });

  it('surfaces the underlying failure when deletion itself throws', async () => {
    await expect(clearOpenRouterCredential({
      hasOpenRouterKey: () => Promise.resolve(true),
      clearOpenRouterKey: () => Promise.reject(new InterleafError('security-violation', 'The credential vault is malformed.')),
      describeStorage: () => USABLE_CREDENTIAL_STORAGE,
    })).rejects.toMatchObject({ code: 'security-violation' });
  });
});

describe('credentials:clear boundary', () => {
  it('accepts only the one documented request shape', () => {
    const schema = ipcRequestSchemas[IPC.credentialsClear];
    expect(schema.safeParse({ providerId: 'openrouter' }).success).toBe(true);
    const malformed: readonly CloneableValue[] = [{}, { providerId: 'anthropic' }, { providerId: 'openrouter', all: true }, null, 'openrouter', []];
    expect(malformed.map((request) => schema.safeParse(request).success)).toEqual(malformed.map(() => false));
  });

  it('deletes through the serialized provider path, never straight to the vault', async () => {
    // Routing matters as much as the deletion itself: reaching the vault
    // directly from the dispatcher would put a second, unserialized writer
    // beside `ai:configure-openrouter` on the same document.
    const touchedVaultDirectly = vi.fn();
    const clearOpenRouterCredentialThroughProvider = vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS));
    const senderRule = createSenderRule({
      indexHtmlPath: '/out/renderer/index.html',
      devUrl: 'http://localhost:5173',
    });
    const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
    registerIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      makeIpcDeps({
        chat: unstubbed<ChatService>('chat', { clearOpenRouterCredential: clearOpenRouterCredentialThroughProvider }),
        credentials: unstubbed<CredentialVault>('credentials', { clearOpenRouterKey: touchedVaultDirectly, hasOpenRouterKey: touchedVaultDirectly }),
        senderRule,
      })
    );

    const handler = handlers.get(IPC.credentialsClear);
    expect(handler).toBeDefined();
    await expect(
      handler!({ senderFrame: { url: senderRule.allowedProductionFileUrl } }, { providerId: 'openrouter' })
    ).resolves.toEqual({ ok: true, data: UNCONFIGURED_CREDENTIAL_STATUS });

    expect(clearOpenRouterCredentialThroughProvider).toHaveBeenCalledTimes(1);
    expect(touchedVaultDirectly).not.toHaveBeenCalled();
  });
});

describe('credentials:get-status preload boundary', () => {
  function bridge(reply: CloneableValue) {
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

  const PREVIEW = { prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'mnop' };
  const STORAGE = USABLE_CREDENTIAL_STORAGE;

  it('passes the two legitimate states through unchanged', async () => {
    const configured = bridge({ configured: true, keyPreview: PREVIEW, storageBackend: STORAGE });
    await expect(configured.api.credentials.getOpenRouterStatus()).resolves.toEqual({
      configured: true,
      keyPreview: PREVIEW,
      storageBackend: STORAGE,
    });
    expect(configured.calls).toEqual([
      { channel: IPC.credentialsGetStatus, payload: { providerId: 'openrouter' } },
    ]);

    // The main-side fail-closed result stays valid: a stored credential whose
    // preview could not be derived.
    const undecryptable = bridge({ configured: true, keyPreview: null, storageBackend: STORAGE });
    await expect(undecryptable.api.credentials.getOpenRouterStatus()).resolves.toEqual({
      configured: true,
      keyPreview: null,
      storageBackend: STORAGE,
    });
    const empty = bridge({ configured: false, keyPreview: null, storageBackend: STORAGE });
    await expect(empty.api.credentials.getOpenRouterStatus()).resolves.toEqual({
      configured: false,
      keyPreview: null,
      storageBackend: STORAGE,
    });
  });

  it('rejects a malformed, inconsistent or padded payload instead of forwarding it', async () => {
    const malformed: readonly CloneableValue[] = [
      // Malformed `configured`, which the renderer used to trust outright.
      { configured: 'true', keyPreview: null, storageBackend: STORAGE },
      { configured: 1, keyPreview: null, storageBackend: STORAGE },
      { keyPreview: null, storageBackend: STORAGE },
      // Inconsistent state: a preview without a stored credential.
      { configured: false, keyPreview: PREVIEW, storageBackend: STORAGE },
      // Malformed previews.
      { configured: true, keyPreview: { prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: 'no' }, storageBackend: STORAGE },
      { configured: true, keyPreview: { prefix: 'sk-live', lastFour: 'mnop' }, storageBackend: STORAGE },
      { configured: true, keyPreview: { prefix: OPENROUTER_KEY_PREVIEW_PREFIX }, storageBackend: STORAGE },
      { configured: true, keyPreview: 'sk-or-v1-...', storageBackend: STORAGE },
      { configured: true, keyPreview: undefined, storageBackend: STORAGE },
      // Extra fields, including a secret-shaped one.
      { configured: true, keyPreview: PREVIEW, apiKey: VALID_KEY, storageBackend: STORAGE },
      { configured: true, keyPreview: { ...PREVIEW, raw: VALID_KEY }, storageBackend: STORAGE },
      null,
      'configured',
      [],
    ];

    for (const reply of malformed) {
      const { api } = bridge(reply);
      await expect(api.credentials.getOpenRouterStatus()).rejects.toMatchObject({
        code: 'internal',
        message: 'The credential store returned an invalid status response.',
      });
    }
  });

  it('never lets a rejected payload carry the secret into the failure', async () => {
    const { api } = bridge({ configured: true, keyPreview: PREVIEW, apiKey: VALID_KEY, storageBackend: STORAGE });
    const error = await rejectionOf(api.credentials.getOpenRouterStatus());
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(VALID_KEY);
  });

  it('sends the fixed clear request and returns only the unconfigured state', async () => {
    const cleared = bridge({ configured: false, keyPreview: null, storageBackend: STORAGE });
    await expect(cleared.api.credentials.clearOpenRouterKey()).resolves.toEqual({
      configured: false,
      keyPreview: null,
      storageBackend: STORAGE,
    });
    expect(cleared.calls).toEqual([
      { channel: IPC.credentialsClear, payload: { providerId: 'openrouter' } },
    ]);
  });

  it('rejects a malformed or secret-bearing removal reply instead of forwarding it', async () => {
    const malformed: readonly CloneableValue[] = [
      { configured: 'false', keyPreview: null, storageBackend: STORAGE },
      { keyPreview: null, storageBackend: STORAGE },
      { configured: false, keyPreview: PREVIEW, storageBackend: STORAGE },
      { configured: false, keyPreview: null, apiKey: VALID_KEY, storageBackend: STORAGE },
      { configured: false, keyPreview: null, removed: true, storageBackend: STORAGE },
      null,
      'removed',
      [],
    ];
    await Promise.all(malformed.map(async (reply) => {
      const { api } = bridge(reply);
      await expect(api.credentials.clearOpenRouterKey()).rejects.toMatchObject({
        code: 'internal',
        message: 'The credential store returned an invalid removal response.',
      });
    }));

    // A rejected reply must not smuggle the secret out through the failure.
    const { api } = bridge({ configured: false, keyPreview: null, apiKey: VALID_KEY, storageBackend: STORAGE });
    const error = await rejectionOf(api.credentials.clearOpenRouterKey());
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(VALID_KEY);
  });
});
