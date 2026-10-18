import { z } from 'zod';
import { openRouterApiKeySchema } from './ai';
import type { PortableMember, PortableValue } from '../models/portable';

/**
 * Masked projection of a stored OpenRouter credential.
 *
 * The raw key stays main-owned. Only the constant public prefix and the last
 * four characters ever cross the preload bridge, so the renderer can tell which
 * saved key is configured without being able to reconstruct it. Every helper
 * here fails closed: anything that is not exactly this shape becomes `null`.
 */
export type OpenRouterKeyPreview = {
  readonly prefix: 'sk-or-v1';
  readonly lastFour: string;
};

export const OPENROUTER_KEY_PREVIEW_PREFIX = 'sk-or-v1';

const PREVIEW_TAIL_LENGTH = 4;

export const openRouterKeyPreviewSchema = z
  .object({
    prefix: z.literal(OPENROUTER_KEY_PREVIEW_PREFIX),
    lastFour: z.string().regex(/^[A-Za-z0-9_-]{4}$/u),
  })
  .strict();

/**
 * Which OS secret store `safeStorage` selected, as a non-secret diagnostic
 * (ADR 0009 §5).
 *
 * Electron only reports a selected backend on Linux; macOS and Windows always
 * use the platform keychain, which this models as `os_keychain`. `basic_text`
 * is the Linux fallback that "encrypts" with a hardcoded key, so it is
 * plaintext-equivalent and must never hold a credential. The value is a
 * backend name and a boolean — it carries no key material and no filesystem
 * path.
 */
export const CREDENTIAL_STORAGE_BACKENDS = [
  'os_keychain',
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'basic_text',
  'unknown',
] as const;

export type CredentialStorageBackend = (typeof CREDENTIAL_STORAGE_BACKENDS)[number];

const CREDENTIAL_STORAGE_PLATFORMS = ['darwin', 'win32', 'linux', 'other'] as const;

export type CredentialStoragePlatform = (typeof CREDENTIAL_STORAGE_PLATFORMS)[number];

export type CredentialStorageStatus = {
  /** Whether main will accept a credential write at all. */
  readonly available: boolean;
  readonly backend: CredentialStorageBackend;
  readonly platform: CredentialStoragePlatform;
};

const credentialStorageStatusSchema = z
  .object({
    available: z.boolean(),
    backend: z.enum(CREDENTIAL_STORAGE_BACKENDS),
    platform: z.enum(CREDENTIAL_STORAGE_PLATFORMS),
  })
  .strict();

/** `basic_text` is Electron's plaintext-equivalent Linux fallback. */
export function isPlaintextCredentialBackend(backend: CredentialStorageBackend): boolean {
  return backend === 'basic_text';
}


/**
 * The complete `credentials:get-status` result.
 *
 * Only two states are legitimate: no credential at all, or a stored credential
 * with either its masked preview or — when decryption or the stored grammar
 * fails — no preview. A preview without a stored credential is inconsistent, so
 * the schema rejects it rather than letting the renderer act on it.
 */
export type OpenRouterCredentialStatus = {
  readonly configured: boolean;
  readonly keyPreview: OpenRouterKeyPreview | null;
  /**
   * Non-secret storage diagnostic, supplied by main on every status answer.
   * Enforcement lives in main's vault; this field only lets the UI explain a
   * refusal before it happens.
   */
  readonly storageBackend: CredentialStorageStatus;
};

export const openRouterCredentialStatusSchema = z
  .object({
    configured: z.boolean(),
    keyPreview: openRouterKeyPreviewSchema.nullable(),
    storageBackend: credentialStorageStatusSchema,
  })
  .strict()
  .refine((status) => status.configured || status.keyPreview === null, {
    message: 'An unconfigured credential cannot carry a key preview.',
    path: ['keyPreview'],
  });

/** Derives the masked preview from a decrypted key, or `null` when the stored
 * value does not match the documented key grammar. */
export function deriveOpenRouterKeyPreview(rawKey: PortableMember): OpenRouterKeyPreview | null {
  const parsed = openRouterApiKeySchema.safeParse(rawKey);
  if (!parsed.success) return null;
  const secret = parsed.data.slice(OPENROUTER_KEY_PREVIEW_PREFIX.length + 1);
  if (secret.length < PREVIEW_TAIL_LENGTH) return null;
  return { prefix: OPENROUTER_KEY_PREVIEW_PREFIX, lastFour: secret.slice(-PREVIEW_TAIL_LENGTH) };
}

/** Re-validates a preview received across a process boundary. */
export function parseOpenRouterKeyPreview(value: PortableValue): OpenRouterKeyPreview | null {
  const parsed = openRouterKeyPreviewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Display form: `sk-or-v1 ···· ···· 4f9c`. */
export function formatOpenRouterKeyPreview(preview: OpenRouterKeyPreview): string {
  return `${preview.prefix} ···· ···· ${preview.lastFour}`;
}
