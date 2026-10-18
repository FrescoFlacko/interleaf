import { errorHasCode } from '@shared/models/caught-error';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { openRouterApiKeySchema } from '@shared/schemas/ai';
import type { CredentialStorageStatus } from '@shared/schemas/credential-preview';
import {
  credentialStorageUnavailableError,
  describeCredentialStorage,
  type CredentialStorageProvider,
} from './credential-storage-backend';
import { isPortableRecord, parsePortableJson } from '@shared/models/portable';

type VaultDocument = {
  readonly version: 1;
  readonly secrets: Readonly<Partial<Record<'openrouter', string>>>;
};

const EMPTY_VAULT: VaultDocument = { version: 1, secrets: {} };
const MAX_VAULT_BYTES = 64 * 1024;

export class CredentialVault {
  constructor(
    private readonly filePath: string,
    private readonly storage: CredentialStorageProvider,
    /** Injected so the Linux backend policy is testable off Linux. */
    private readonly platform: string = process.platform
  ) {}

  /** Non-secret report on the store this vault writes to (ADR 0009 §5); safe
   * to project to the renderer through `credentials:get-status`. */
  describeStorage(): CredentialStorageStatus {
    return describeCredentialStorage(this.storage, this.platform);
  }

  async setOpenRouterKey(secret: string): Promise<void> {
    const parsed = openRouterApiKeySchema.safeParse(secret);
    if (!parsed.success) {
      throw new InterleafError('validation', 'OpenRouter API key is invalid.');
    }
    const trimmed = parsed.data;
    this.requireEncryption();
    const current = await this.readDocument();
    const encrypted = this.storage.encryptString(trimmed).toString('base64');
    await this.writeDocument({ version: 1, secrets: { ...current.secrets, openrouter: encrypted } });
  }

  /**
   * Drops the OpenRouter record from the vault document.
   *
   * No decryption and no encryption-availability check happens here: removal
   * must work for a ciphertext that the current OS key can no longer read, and
   * it never needs the plaintext. A document that cannot be parsed at all
   * still fails closed in `readDocument` rather than being overwritten with an
   * empty vault, because that would destroy records whose contents were never
   * established (ADR 0009 §6).
   */
  async clearOpenRouterKey(): Promise<void> {
    const current = await this.readDocument();
    const secrets = { ...current.secrets };
    delete secrets.openrouter;
    await this.writeDocument({ version: 1, secrets });
  }

  async hasOpenRouterKey(): Promise<boolean> {
    const current = await this.readDocument();
    return typeof current.secrets.openrouter === 'string' && current.secrets.openrouter.length > 0;
  }

  async getOpenRouterKey(): Promise<string | null> {
    this.requireEncryption();
    const current = await this.readDocument();
    const encrypted = current.secrets.openrouter;
    if (!encrypted) return null;
    try {
      return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      throw new InterleafError('security-violation', 'The stored OpenRouter credential could not be decrypted.', {
        cause: error instanceof Error ? error : null,
      });
    }
  }

  /**
   * Fails closed when the platform cannot protect the secret: `safeStorage`
   * reports no encryption at all, or — on Linux — selected the
   * plaintext-equivalent `basic_text` backend (ADR 0009 §5).
   */
  private requireEncryption(): void {
    const storage = this.describeStorage();
    if (!storage.available) throw credentialStorageUnavailableError(storage);
  }

  private async readDocument(): Promise<VaultDocument> {
    const raw = await this.readVaultFile();
    if (raw === null) return EMPTY_VAULT;
    if (Buffer.byteLength(raw, 'utf8') > MAX_VAULT_BYTES) {
      throw new InterleafError('security-violation', 'The credential vault exceeds the safe size limit.');
    }
    return parseVaultDocument(raw);
  }

  /** The vault file's contents, or `null` when no vault has been written yet. */
  private async readVaultFile(): Promise<string | null> {
    try {
      return await readFile(this.filePath, { encoding: 'utf8', flag: 'r' });
    } catch (error) {
      const caught = error instanceof Error ? error : null;
      if (errorHasCode(caught, 'ENOENT')) return null;
      throw new InterleafError('internal', 'Could not read the encrypted credential vault.', { cause: caught });
    }
  }

  private async writeDocument(document: VaultDocument): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp-${String(process.pid)}-${randomUUID()}`;
    const serialized = JSON.stringify(document);
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new InterleafError('internal', 'Could not update the encrypted credential vault.', { cause: error instanceof Error ? error : null });
    }
  }
}

/**
 * The stored vault, or a typed failure.
 *
 * Only the exact document this vault writes is accepted: a wrong version, a
 * missing secrets object or a non-string entry is a malformed vault rather than
 * something to repair, because a credential store must never guess.
 */
function parseVaultDocument(raw: string): VaultDocument {
  try {
    const parsed = parsePortableJson(raw);
    if (!isPortableRecord(parsed) || parsed.version !== 1) throw new Error('invalid vault shape');
    const secrets = parsed.secrets;
    if (!isPortableRecord(secrets)) throw new Error('invalid vault shape');
    const openrouter = secrets.openrouter;
    if (openrouter !== undefined && typeof openrouter !== 'string') throw new Error('invalid secret entry');
    return { version: 1, secrets: { ...(openrouter === undefined || openrouter === '' ? {} : { openrouter }) } };
  } catch (error) {
    throw new InterleafError('security-violation', 'The credential vault is malformed.', {
      cause: error instanceof Error ? error : null,
    });
  }
}
