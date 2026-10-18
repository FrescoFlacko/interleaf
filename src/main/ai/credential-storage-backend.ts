import type { SafeStorage } from 'electron';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  CREDENTIAL_STORAGE_BACKENDS,
  isPlaintextCredentialBackend,
  type CredentialStorageBackend,
  type CredentialStoragePlatform,
  type CredentialStorageStatus,
} from '@shared/schemas/credential-preview';

/**
 * The `safeStorage` surface the credential vault depends on.
 *
 * `getSelectedStorageBackend` is optional and widened to `string` so the
 * backend policy stays injectable — a test can name a backend, omit the probe
 * entirely, or make it throw — and so an unrecognised name is handled rather
 * than assumed impossible.
 */
export type CredentialStorageProvider = Pick<
  SafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'
> & {
  readonly getSelectedStorageBackend?: () => string;
};

function normalizePlatform(platform: string): CredentialStoragePlatform {
  const known = (['darwin', 'win32', 'linux'] as const).find((name) => name === platform);
  return known ?? 'other';
}

function probe(storage: CredentialStorageProvider): CredentialStorageBackend {
  const read = storage.getSelectedStorageBackend;
  try {
    const selected: string | undefined = read?.call(storage);
    return CREDENTIAL_STORAGE_BACKENDS.find((backend) => backend === selected) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function encryptionAvailable(storage: CredentialStorageProvider): boolean {
  try {
    return storage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Non-secret description of the store a credential would be written to
 * (ADR 0009 §5).
 *
 * macOS and Windows always use the OS keychain and Electron reports no
 * selected backend for them, so only Linux is probed; a probe that throws or
 * names something unrecognised degrades to `unknown`, which stays usable.
 * Only the plaintext-equivalent `basic_text` — Electron's Linux fallback that
 * "encrypts" with a hardcoded key — makes the store unavailable on its own.
 * The result carries no key material and no filesystem path, so it is safe to
 * project to the renderer.
 */
export function describeCredentialStorage(
  storage: CredentialStorageProvider,
  platform: string
): CredentialStorageStatus {
  const resolved = normalizePlatform(platform);
  const keychain = resolved === 'darwin' || resolved === 'win32';
  const backend: CredentialStorageBackend = keychain ? 'os_keychain' : probe(storage);
  return {
    available: encryptionAvailable(storage) && !isPlaintextCredentialBackend(backend),
    backend,
    platform: resolved,
  };
}

/**
 * The single fail-closed refusal for a store that cannot protect a secret.
 * Both causes raise the same security-violation class; only the wording
 * differs, because the user's remedy differs.
 */
export function credentialStorageUnavailableError(status: CredentialStorageStatus): InterleafError {
  return new InterleafError(
    'security-violation',
    isPlaintextCredentialBackend(status.backend)
      ? 'OS-backed credential encryption is unavailable: the selected storage backend keeps secrets in plaintext. Interleaf will not store API keys in plaintext.'
      : 'OS-backed credential encryption is unavailable. Interleaf will not store API keys in plaintext.'
  );
}
