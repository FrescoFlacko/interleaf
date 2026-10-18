import { describe, expect, it } from 'vitest';
import { sign } from 'node:crypto';
import { signedMessage } from '@main/updates/update-envelope';
import { MAX_MANIFEST_BYTES, UpdateVerificationError, verifyUpdateManifest, type ManifestExpectation } from '@main/updates/update-manifest';
import { UPDATE_TRUST } from '@main/updates/update-trust';
import { signManifest } from '../../electron.update-release';
import { appImageEntry, ephemeralSigner, signedManifest, zipEntry, type TestSigner } from '../helpers/update-signing';

/**
 * A manifest is trusted only when a pinned key signed its exact bytes and the
 * signed statement names this product, platform, stable version, tag and
 * exactly one file for this architecture. Every other shape is rejected with
 * an `UpdateVerificationError`, before any file is downloaded.
 */

const signer = ephemeralSigner();
const darwin = (arch: string, trust = signer.trust): ManifestExpectation => ({ trust, platform: 'darwin', arch });

function rejection(text: string, expectation: ManifestExpectation): string {
  try {
    verifyUpdateManifest(text, expectation);
  } catch (error) {
    if (error instanceof UpdateVerificationError) return error.reason;
    throw error;
  }
  throw new Error('The manifest was accepted.');
}

function envelopeOf(text: string): Record<string, string> {
  return JSON.parse(text) as Record<string, string>;
}

/** Signs an arbitrary payload object with `by`, bypassing the release tool's fixed field set. */
function signedPayload(by: TestSigner, payload: object): string {
  return signManifest(Buffer.from(JSON.stringify(payload), 'utf8'), by.key);
}

const basePayload = {
  schemaVersion: 1,
  product: UPDATE_TRUST.product,
  channel: 'stable',
  platform: 'darwin',
  version: '1.2.3',
  tag: 'v1.2.3',
  releaseDate: '2026-10-01T12:00:00.000Z',
  files: [zipEntry('1.2.3', 'arm64'), zipEntry('1.2.3', 'x64')],
};

describe('verifyUpdateManifest', () => {
  it('returns the single verified file for each macOS architecture and the Linux AppImage', () => {
    const text = signedManifest(signer);
    expect(verifyUpdateManifest(text, darwin('arm64'))).toEqual({
      version: '1.2.3',
      tag: 'v1.2.3',
      releaseDate: '2026-10-01T12:00:00.000Z',
      file: zipEntry('1.2.3', 'arm64'),
    });
    expect(verifyUpdateManifest(text, darwin('x64')).file.name).toBe('Interleaf-1.2.3-mac.zip');
    const linux = signedManifest(signer, { platform: 'linux' });
    expect(verifyUpdateManifest(linux, { trust: signer.trust, platform: 'linux', arch: 'x64' }).file).toEqual(appImageEntry('1.2.3'));
  });

  it('fails closed when the build pins no key', () => {
    expect(rejection(signedManifest(signer), darwin('arm64', UPDATE_TRUST))).toBe('signed by a key this build does not trust');
  });

  it('rejects a manifest signed by a key the build does not pin', () => {
    const stranger = ephemeralSigner();
    expect(rejection(signedManifest(stranger), darwin('arm64'))).toBe('signed by a key this build does not trust');
  });

  it('rejects a pinned key id whose bytes are someone else’s key', () => {
    const stranger = ephemeralSigner();
    const [pinned] = signer.trust.signingKeys;
    const [foreign] = stranger.trust.signingKeys;
    if (pinned === undefined || foreign === undefined) throw new Error('missing key');
    const swapped = { ...signer.trust, signingKeys: [{ keyId: pinned.keyId, spkiBase64: foreign.spkiBase64 }] };
    expect(rejection(signedManifest(signer), darwin('arm64', swapped))).toBe('signed by a key this build does not trust');
  });

  it('rejects a payload altered after signing', () => {
    const envelope = envelopeOf(signedManifest(signer));
    const forged = Buffer.from(Buffer.from(envelope.payload ?? '', 'base64').toString('utf8').replace('1.2.3', '9.2.3'), 'utf8');
    const text = JSON.stringify({ ...envelope, payload: forged.toString('base64') });
    expect(rejection(text, darwin('arm64'))).toBe('signature does not verify');
  });

  it('rejects a signature over the payload without the manifest domain prefix', () => {
    const envelope = envelopeOf(signedManifest(signer));
    const payload = Buffer.from(envelope.payload ?? '', 'base64');
    const bare = sign(null, payload, signer.key.privateKey).toString('base64');
    expect(rejection(JSON.stringify({ ...envelope, signature: bare }), darwin('arm64'))).toBe('signature does not verify');
    expect(sign(null, signedMessage(payload), signer.key.privateKey).toString('base64')).toBe(envelope.signature);
  });

  it('rejects malformed, extended and oversized envelopes', () => {
    const envelope = envelopeOf(signedManifest(signer));
    expect(rejection('not json', darwin('arm64'))).toBe('not JSON');
    expect(rejection(JSON.stringify({ ...envelope, extra: 'x' }), darwin('arm64'))).toBe('malformed envelope');
    expect(rejection(JSON.stringify({ ...envelope, format: 'other/v1' }), darwin('arm64'))).toBe('malformed envelope');
    expect(rejection(' '.repeat(MAX_MANIFEST_BYTES + 1), darwin('arm64'))).toBe('too large');
  });

  it('rejects another product, platform or channel even when properly signed', () => {
    const otherProduct = signedManifest(signer, { trust: { ...signer.trust, product: 'com.example.other' } });
    expect(rejection(otherProduct, darwin('arm64'))).toBe('wrong product');
    const linux = signedManifest(signer, { platform: 'linux' });
    expect(rejection(linux, darwin('x64'))).toBe('wrong platform');
    expect(rejection(signedPayload(signer, { ...basePayload, channel: 'beta' }), darwin('arm64'))).toBe('malformed payload');
  });

  it('rejects pre-release versions and tags that do not name the version', () => {
    expect(rejection(signedPayload(signer, { ...basePayload, version: '1.2.3-beta.1', tag: 'v1.2.3-beta.1' }), darwin('arm64'))).toBe(
      'malformed payload',
    );
    expect(rejection(signedPayload(signer, { ...basePayload, tag: 'v1.2.4' }), darwin('arm64'))).toBe('tag does not match version');
    expect(rejection(signedPayload(signer, { ...basePayload, extra: true }), darwin('arm64'))).toBe('malformed payload');
  });

  it('rejects a file list with no file for this architecture, a mislabelled arch, or a duplicate', () => {
    const armOnly = signedManifest(signer, { files: [zipEntry('1.2.3', 'arm64')] });
    expect(rejection(armOnly, darwin('x64'))).toBe('no single x64 file');
    const mislabelled = signedManifest(signer, { files: [{ ...zipEntry('1.2.3', 'arm64'), arch: 'x64' }] });
    expect(rejection(mislabelled, darwin('x64'))).toMatch(/does not match the release/);
    const duplicate = signedManifest(signer, { files: [zipEntry('1.2.3', 'arm64'), zipEntry('1.2.3', 'arm64')] });
    expect(rejection(duplicate, darwin('arm64'))).toBe('duplicate file names');
    const wrongVersion = signedManifest(signer, { files: [zipEntry('1.2.2', 'arm64')] });
    expect(rejection(wrongVersion, darwin('arm64'))).toMatch(/does not match the release/);
    const wrongKind = signedManifest(signer, { files: [appImageEntry('1.2.3')] });
    expect(rejection(wrongKind, darwin('x64'))).toMatch(/does not match the release/);
  });

  it('rejects unsafe file names and malformed digests', () => {
    const traversal = signedManifest(signer, { files: [{ ...zipEntry('1.2.3', 'arm64'), name: '../Interleaf-1.2.3-arm64-mac.zip' }] });
    expect(rejection(traversal, darwin('arm64'))).toBe('malformed payload');
    const badDigest = signedManifest(signer, { files: [{ ...zipEntry('1.2.3', 'arm64'), sha512: 'abc' }] });
    expect(rejection(badDigest, darwin('arm64'))).toBe('malformed payload');
  });
});
