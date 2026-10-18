import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { UpdateSigningKey } from './update-trust';

/**
 * The signed-manifest envelope, shared by the app's verifier and the release
 * tool that signs (electron.update-release.ts).
 *
 * The signature covers a fixed domain-separation prefix followed by the exact
 * payload bytes, so a signature over a manifest cannot be replayed as any
 * other kind of signed object, and the payload is parsed only after its bytes
 * verify. Signing and verification are Node's own Ed25519; nothing here is
 * home-made cryptography.
 *
 * This module imports nothing but `node:crypto` and types, so the release tool
 * can load it directly with Node's type stripping and sign exactly the bytes
 * the app will check.
 */

export const UPDATE_MANIFEST_FORMAT = 'interleaf-update-manifest/v1';
const UPDATE_SIGNATURE_DOMAIN = `${UPDATE_MANIFEST_FORMAT}\n`;

export type UpdateManifestEnvelope = {
  readonly format: typeof UPDATE_MANIFEST_FORMAT;
  readonly keyId: string;
  /** Base64 of the exact UTF-8 payload bytes that were signed. */
  readonly payload: string;
  /** Base64 detached Ed25519 signature. */
  readonly signature: string;
};

/** First 16 hex characters of SHA-256 over the DER SubjectPublicKeyInfo. */
export function signingKeyId(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

/** The bytes a signature covers: the domain prefix, then the payload bytes. */
export function signedMessage(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(UPDATE_SIGNATURE_DOMAIN, 'utf8'), payload]);
}

/** The pinned key object for `keyId`; an entry whose id does not match its own bytes is ignored. */
export function pinnedKey(keys: readonly UpdateSigningKey[], keyId: string): KeyObject | undefined {
  const entry = keys.find((key) => key.keyId === keyId);
  if (entry === undefined) return undefined;
  const der = Buffer.from(entry.spkiBase64, 'base64');
  if (signingKeyId(der) !== entry.keyId) return undefined;
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  return key.asymmetricKeyType === 'ed25519' ? key : undefined;
}

/** Whether `signature` is a valid Ed25519 signature by `key` over the domain-prefixed payload. */
export function payloadSignatureValid(payload: Buffer, signature: Buffer, key: KeyObject): boolean {
  return signature.length === 64 && verify(null, signedMessage(payload), key, signature);
}
