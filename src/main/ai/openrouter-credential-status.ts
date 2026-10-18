import { InterleafError } from '@shared/errors/interleaf-error';
import {
  deriveOpenRouterKeyPreview,
  type CredentialStorageStatus,
  type OpenRouterCredentialStatus,
} from '@shared/schemas/credential-preview';

type CredentialReader = {
  hasOpenRouterKey(): Promise<boolean>;
  getOpenRouterKey(): Promise<string | null>;
  describeStorage(): CredentialStorageStatus;
};

type CredentialRemover = {
  hasOpenRouterKey(): Promise<boolean>;
  clearOpenRouterKey(): Promise<void>;
  describeStorage(): CredentialStorageStatus;
};

/**
 * Projects the main-owned OpenRouter credential into the masked status the
 * renderer is allowed to see. Decryption problems degrade to "configured
 * without a preview" rather than surfacing vault internals. The storage
 * backend is a non-secret machine fact (ADR 0009 §5) that lets Settings
 * explain a refusal before the user types a key; enforcement stays in the
 * vault, so a renderer that ignores it still cannot store plaintext.
 */
export async function readOpenRouterCredentialStatus(
  credentials: CredentialReader
): Promise<OpenRouterCredentialStatus> {
  const storageBackend = credentials.describeStorage();
  const configured = await credentials.hasOpenRouterKey();
  if (!configured) return { configured: false, keyPreview: null, storageBackend };
  const keyPreview = await credentials.getOpenRouterKey().then(deriveOpenRouterKeyPreview, () => null);
  return { configured: true, keyPreview, storageBackend };
}

/**
 * Deletes the stored OpenRouter credential and reports the status that
 * replaces it.
 *
 * Removal deliberately never reads the secret: the record is dropped from the
 * vault document, so a ciphertext left undecryptable by an OS-key change is
 * removable exactly like a readable one. Because nothing is decrypted, the
 * answer can only ever be the unconfigured state; presence is re-checked so a
 * deletion that did not actually take effect is reported as a failure rather
 * than as a credential the reader no longer has.
 *
 * The delete and the re-check are one unit only because the caller serializes
 * them: `OpenRouterProvider.clearCredential` runs this under the same lock as
 * `configure`, which is what makes the re-check a statement about the store
 * rather than about a moment that a concurrent replacement could have moved.
 */
export async function clearOpenRouterCredential(
  credentials: CredentialRemover
): Promise<OpenRouterCredentialStatus> {
  await credentials.clearOpenRouterKey();
  if (await credentials.hasOpenRouterKey()) {
    throw new InterleafError('internal', 'The OpenRouter credential could not be removed from secure storage.');
  }
  return { configured: false, keyPreview: null, storageBackend: credentials.describeStorage() };
}
