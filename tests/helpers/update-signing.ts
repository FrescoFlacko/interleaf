import { createHash, generateKeyPairSync } from 'node:crypto';
import { signingKeyId } from '@main/updates/update-envelope';
import { UPDATE_TRUST, type UpdateTrust } from '@main/updates/update-trust';
import { manifestPayload, signManifest, type ManifestFile, type SigningKey } from '../../electron.update-release';

/**
 * Ephemeral update-signing material for tests. Every key is generated in
 * memory for one test run; no production key, and no key file in the
 * repository, is ever involved.
 */

export type TestSigner = { readonly key: SigningKey; readonly trust: UpdateTrust };

export function ephemeralSigner(origin = UPDATE_TRUST.origin): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = signingKeyId(spki);
  return {
    key: { keyId, privateKey },
    trust: { ...UPDATE_TRUST, origin, signingKeys: [{ keyId, spkiBase64: spki.toString('base64') }] },
  };
}

const sha512Base64 = (bytes: Buffer | string): string => createHash('sha512').update(bytes).digest('base64');

export function zipEntry(version: string, arch: 'arm64' | 'x64', bytes: Buffer | string = `zip-${arch}`): ManifestFile {
  const name = arch === 'arm64' ? `Interleaf-${version}-arm64-mac.zip` : `Interleaf-${version}-mac.zip`;
  return { name, arch, kind: 'zip', size: Buffer.byteLength(bytes), sha512: sha512Base64(bytes) };
}

export function appImageEntry(version: string, bytes: Buffer | string = 'appimage', blockMapSize = 16): ManifestFile {
  return { name: `Interleaf-${version}.AppImage`, arch: 'x64', kind: 'AppImage', size: Buffer.byteLength(bytes), sha512: sha512Base64(bytes), blockMapSize };
}

export type ManifestOverrides = {
  readonly platform?: 'darwin' | 'linux';
  readonly version?: string;
  readonly files?: readonly ManifestFile[];
  readonly releaseDate?: string;
  readonly trust?: UpdateTrust;
};

/** A manifest signed by `signer`, for darwin by default with both ZIPs. */
export function signedManifest(signer: TestSigner, overrides: ManifestOverrides = {}): string {
  const version = overrides.version ?? '1.2.3';
  const platform = overrides.platform ?? 'darwin';
  const files = overrides.files ?? (platform === 'darwin' ? [zipEntry(version, 'arm64'), zipEntry(version, 'x64')] : [appImageEntry(version)]);
  const payload = manifestPayload({
    trust: overrides.trust ?? signer.trust,
    platform,
    version,
    releaseDate: overrides.releaseDate ?? '2026-10-01T12:00:00.000Z',
    files,
  });
  return signManifest(payload, signer.key);
}
