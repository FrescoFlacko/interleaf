import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { CredentialVault } from '@main/ai/credential-vault';
import type { CredentialStorageProvider } from '@main/ai/credential-storage-backend';

function makeTempVaultPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-vault-'));
  return path.join(dir, 'credentials.json');
}

describe('CredentialVault', () => {
  let vaultPath: string;
  let encryptionAvailable: boolean;
  let mockStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (plain: string) => Buffer;
    decryptString: (encrypted: Buffer) => string;
  };

  beforeEach(() => {
    vaultPath = makeTempVaultPath();
    encryptionAvailable = true;
    mockStorage = {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (plain: string) => Buffer.from(`encrypted:${plain}`, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        const str = encrypted.toString('utf8');
        if (!str.startsWith('encrypted:')) throw new Error('Decryption failure');
        return str.slice('encrypted:'.length);
      },
    };
  });

  afterEach(() => {
    try {
      rmSync(path.dirname(vaultPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('stores and retrieves encrypted OpenRouter API key with restricted file permissions', async () => {
    const vault = new CredentialVault(vaultPath, mockStorage);
    expect(await vault.hasOpenRouterKey()).toBe(false);
    expect(await vault.getOpenRouterKey()).toBeNull();

    await vault.setOpenRouterKey('sk-or-v1-secret-key-12345');
    expect(await vault.hasOpenRouterKey()).toBe(true);
    expect(await vault.getOpenRouterKey()).toBe('sk-or-v1-secret-key-12345');

    // Verify file mode permissions on POSIX
    if (process.platform !== 'win32') {
      const stats = statSync(vaultPath);
      expect(stats.mode & 0o777).toBe(0o600);
    }

    await vault.clearOpenRouterKey();
    expect(await vault.hasOpenRouterKey()).toBe(false);
    expect(await vault.getOpenRouterKey()).toBeNull();
  });

  it('fails closed when OS-backed encryption is unavailable', async () => {
    encryptionAvailable = false;
    const vault = new CredentialVault(vaultPath, mockStorage);

    await expect(vault.setOpenRouterKey('sk-or-v1-secret')).rejects.toThrow(
      /OS-backed credential encryption is unavailable/i
    );
    await expect(vault.getOpenRouterKey()).rejects.toThrow(
      /OS-backed credential encryption is unavailable/i
    );
  });

  it('rejects invalid, empty, or oversized API keys', async () => {
    const vault = new CredentialVault(vaultPath, mockStorage);
    await expect(vault.setOpenRouterKey('')).rejects.toThrow(/OpenRouter API key is invalid/i);
    await expect(vault.setOpenRouterKey('   ')).rejects.toThrow(/OpenRouter API key is invalid/i);
    await expect(vault.setOpenRouterKey('x'.repeat(513))).rejects.toThrow(/OpenRouter API key is invalid/i);
  });

  it('removes a stored key the current OS key can no longer decrypt', async () => {
    // The shape the identity/profile migration leaves behind: a structurally
    // valid vault whose ciphertext was written under a key that is now gone.
    writeFileSync(vaultPath, JSON.stringify({ version: 1, secrets: { openrouter: Buffer.from('stale-os-key-ciphertext', 'utf8').toString('base64') } }), 'utf8');
    let decryptCalls = 0;
    const vault = new CredentialVault(vaultPath, {
      ...mockStorage,
      decryptString: (encrypted: Buffer) => { decryptCalls += 1; return mockStorage.decryptString(encrypted); },
    });
    await expect(vault.getOpenRouterKey()).rejects.toThrow(/could not be decrypted/i);

    decryptCalls = 0;
    await vault.clearOpenRouterKey();

    // Removal never reads the secret, so an unreadable record clears like any
    // other, and nothing is left behind to keep reporting a credential.
    expect(decryptCalls).toBe(0);
    expect(await vault.hasOpenRouterKey()).toBe(false);
  });

  it('removes a malformed-base64 ciphertext, and still refuses a malformed document', async () => {
    writeFileSync(vaultPath, JSON.stringify({ version: 1, secrets: { openrouter: '!!!not base64!!!' } }), 'utf8');
    const vault = new CredentialVault(vaultPath, mockStorage);
    await vault.clearOpenRouterKey();
    expect(await vault.hasOpenRouterKey()).toBe(false);

    // Removal must not work by blindly overwriting: a document whose contents
    // were never established is not destroyed speculatively (ADR 0009 §6).
    writeFileSync(vaultPath, '{ truncated', 'utf8');
    await expect(vault.clearOpenRouterKey()).rejects.toThrow(/credential vault is malformed/i);
  });

  it('removes a stored key without OS-backed encryption available', async () => {
    const vault = new CredentialVault(vaultPath, mockStorage);
    await vault.setOpenRouterKey('sk-or-v1-secret-key-12345');

    // The key that encrypted it may be unavailable now; deletion needs neither
    // encryption nor decryption, so recovery stays possible.
    encryptionAvailable = false;
    await vault.clearOpenRouterKey();
    expect(await vault.hasOpenRouterKey()).toBe(false);
  });

  it('rejects malformed or oversized vault files', async () => {
    writeFileSync(vaultPath, 'not-valid-json', 'utf8');
    const vault = new CredentialVault(vaultPath, mockStorage);
    await expect(vault.hasOpenRouterKey()).rejects.toThrow(/credential vault is malformed/i);

    writeFileSync(vaultPath, 'x'.repeat(65 * 1024), 'utf8');
    await expect(vault.hasOpenRouterKey()).rejects.toThrow(/exceeds the safe size limit/i);
  });
});

describe('CredentialVault storage-backend policy (ADR 0009 §5)', () => {
  let vaultPath: string;

  const cipher = {
    encryptString: (plain: string): Buffer => Buffer.from(`encrypted:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer): string => encrypted.toString('utf8'),
  };
  const available = { ...cipher, isEncryptionAvailable: (): boolean => true };

  function withBackend(name: string): CredentialStorageProvider {
    return { ...available, getSelectedStorageBackend: (): string => name };
  }

  beforeEach(() => {
    vaultPath = makeTempVaultPath();
  });

  afterEach(() => {
    try {
      rmSync(path.dirname(vaultPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reports the OS keychain on macOS and Windows without probing a backend', () => {
    const probe = vi.fn((): string => 'basic_text');
    const storage: CredentialStorageProvider = { ...available, getSelectedStorageBackend: probe };

    expect(new CredentialVault(vaultPath, storage, 'darwin').describeStorage())
      .toEqual({ available: true, backend: 'os_keychain', platform: 'darwin' });
    expect(new CredentialVault(vaultPath, storage, 'win32').describeStorage())
      .toEqual({ available: true, backend: 'os_keychain', platform: 'win32' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports the selected Linux backend and stays usable for a real secret service', async () => {
    const vault = new CredentialVault(vaultPath, withBackend('gnome_libsecret'), 'linux');

    expect(vault.describeStorage())
      .toEqual({ available: true, backend: 'gnome_libsecret', platform: 'linux' });
    await vault.setOpenRouterKey('sk-or-v1-secret-key-12345');
    expect(await vault.hasOpenRouterKey()).toBe(true);
  });

  it('fails closed on the plaintext-equivalent basic_text backend', async () => {
    const vault = new CredentialVault(vaultPath, withBackend('basic_text'), 'linux');

    expect(vault.describeStorage())
      .toEqual({ available: false, backend: 'basic_text', platform: 'linux' });
    await expect(vault.setOpenRouterKey('sk-or-v1-secret-key-12345')).rejects.toMatchObject({
      code: 'security-violation',
    });
    await expect(vault.setOpenRouterKey('sk-or-v1-secret-key-12345')).rejects.toThrow(/plaintext/iu);
    await expect(vault.getOpenRouterKey()).rejects.toThrow(/plaintext/iu);

    // Nothing was stored, and removal still needs no encryption.
    await vault.clearOpenRouterKey();
    expect(await vault.hasOpenRouterKey()).toBe(false);
  });

  it('degrades an unreported or unrecognised backend probe to unknown', () => {
    expect(new CredentialVault(vaultPath, available, 'linux').describeStorage())
      .toEqual({ available: true, backend: 'unknown', platform: 'linux' });
    expect(new CredentialVault(vaultPath, withBackend('hypr_secrets'), 'linux').describeStorage().backend)
      .toBe('unknown');
  });

  it('degrades a throwing probe and an unknown platform without failing', () => {
    const throwing: CredentialStorageProvider = {
      ...available,
      getSelectedStorageBackend: vi.fn((): string => { throw new Error('no secret service'); }),
    };

    expect(new CredentialVault(vaultPath, throwing, 'linux').describeStorage())
      .toEqual({ available: true, backend: 'unknown', platform: 'linux' });
    expect(new CredentialVault(vaultPath, available, 'freebsd').describeStorage().platform).toBe('other');
  });

  it('stays unavailable when encryption itself is off, whatever the backend says', () => {
    const storage: CredentialStorageProvider = {
      ...cipher,
      isEncryptionAvailable: (): boolean => false,
      getSelectedStorageBackend: (): string => 'kwallet6',
    };

    expect(new CredentialVault(vaultPath, storage, 'linux').describeStorage())
      .toEqual({ available: false, backend: 'kwallet6', platform: 'linux' });
  });
});
