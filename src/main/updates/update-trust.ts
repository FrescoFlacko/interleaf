/**
 * The pinned trust anchor for application updates.
 *
 * Everything an update is allowed to come from is fixed here, at build time:
 * the public releases-only GitHub repository, the product identity a signed
 * release manifest must name, and the Ed25519 public keys allowed to sign one.
 * Nothing in this module is configurable at runtime, by settings, by an
 * environment variable or by the renderer, and no key is ever fetched from the
 * network. The source repository is never a distribution channel; only release
 * assets live in the releases-only destination.
 *
 * A GitHub release proves only that someone with write access to the release
 * repository uploaded the files. The publisher is authenticated by the
 * detached Ed25519 signature over the release manifest, made with a signing
 * key that never enters this repository, its artifacts or its logs (see
 * docs/PACKAGING.md, "Update signing key"). The manifest's SHA-512 digests then
 * bind every downloaded byte to that signed statement.
 *
 * Key rotation: ship one release that pins both the current and the next key,
 * still signed by the current key; sign every later release with the next key
 * and drop the old entry in a following release. A build that pins no key
 * (a malformed smoke anchor, for instance) refuses every update ("not
 * configured") without contacting the feed.
 */

export type UpdateSigningKey = {
  /** First 16 hex characters of SHA-256 over the DER SubjectPublicKeyInfo. */
  readonly keyId: string;
  /** Base64 DER SubjectPublicKeyInfo of an Ed25519 public key. */
  readonly spkiBase64: string;
};

export type UpdateTrust = {
  /** The application identity a manifest must name (electron-builder `appId`). */
  readonly product: string;
  /** The only origin manifests, artifacts and blockmaps may be requested from. */
  readonly origin: string;
  /** `/<owner>/<repo>` of the public releases-only repository. */
  readonly repositoryPath: string;
  readonly signingKeys: readonly UpdateSigningKey[];
};

export const RELEASE_OWNER = 'FrescoFlacko';
export const RELEASE_REPOSITORY = 'interleaf-releases';

export const UPDATE_TRUST: UpdateTrust = {
  product: 'com.interleaf.app',
  origin: 'https://github.com',
  repositoryPath: `/${RELEASE_OWNER}/${RELEASE_REPOSITORY}`,
  // The production release key, generated with `node electron.update-release.ts
  // keygen`. Only its public half is here; the private key lives outside the
  // repository, its artifacts and its logs.
  signingKeys: [{ keyId: 'b448deb8c896ef18', spkiBase64: 'MCowBQYDK2VwAyEAx8dTJfZRDdouR3ph4A9xRtvxlgZstXGuNiPj2v746E0=' }],
};

/** The signed manifest each platform reads from the latest stable release. */
export function manifestAssetName(platform: 'darwin' | 'linux'): string {
  return platform === 'darwin' ? 'interleaf-stable-mac.json' : 'interleaf-stable-linux-x64.json';
}

/** `…/releases/latest/download/<asset>`: GitHub's latest non-draft, non-prerelease release. */
export function latestManifestUrl(trust: UpdateTrust, platform: 'darwin' | 'linux'): URL {
  return new URL(`${trust.repositoryPath}/releases/latest/download/${manifestAssetName(platform)}`, trust.origin);
}

/** `…/releases/download/v<version>/<asset>`: the immutable tag a verified manifest names. */
export function taggedAssetUrl(trust: UpdateTrust, tag: string, assetName: string): URL {
  return new URL(`${trust.repositoryPath}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`, trust.origin);
}

/** The public release page; truthful whether or not a release has been published yet. */
export function releasePageUrl(trust: UpdateTrust): string {
  return new URL(`${trust.repositoryPath}/releases`, trust.origin).href;
}
