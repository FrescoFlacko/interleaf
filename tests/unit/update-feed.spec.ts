import { describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey } from 'node:crypto';
import type { UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { createManifestFetcher, type FetchLike } from '@main/updates/manifest-fetch';
import { MAX_MANIFEST_BYTES, UpdateVerificationError } from '@main/updates/update-manifest';
import {
  NoPublishedReleaseError,
  SignedReleaseProvider,
  UpdateNetworkError,
  UpdateNotConfiguredError,
  type ManifestFetcher,
} from '@main/updates/signed-release-provider';
import { UPDATE_TRUST, latestManifestUrl } from '@main/updates/update-trust';
import { classifyUpdateError, errorLogMeta, updateErrorMessage } from '@main/updates/update-errors';
import { appImageEntry, ephemeralSigner, signedManifest } from '../helpers/update-signing';

/**
 * The feed half of updating: the custom electron-updater provider reads only
 * the signed manifest at the pinned origin and hands electron-updater nothing
 * it did not verify, the manifest request is bounded and credential-free, and
 * every failure becomes one fixed, safe error code.
 */

const signer = ephemeralSigner();
const RELEASES = 'https://github.com/FrescoFlacko/interleaf-releases';
const runtimeOptions: ProviderRuntimeOptions = {
  isUseMultipleRangeRequest: false,
  platform: 'darwin',
  executor: {} as ProviderRuntimeOptions['executor'],
};

function provider(fetchManifest: ManifestFetcher, trust = signer.trust, platform: 'darwin' | 'linux' = 'darwin', arch = 'arm64'): SignedReleaseProvider {
  return new SignedReleaseProvider({ trust, platform, arch, fetchManifest }, runtimeOptions);
}

const serving = (text: string): ManifestFetcher => vi.fn(() => Promise.resolve({ status: 'found' as const, text }));

describe('SignedReleaseProvider', () => {
  it('reads only the pinned latest manifest and builds update info from the verified file', async () => {
    const fetchManifest = serving(signedManifest(signer));
    const feed = provider(fetchManifest);
    const info = await feed.getLatestVersion();
    expect(fetchManifest).toHaveBeenCalledExactlyOnceWith(new URL(`${RELEASES}/releases/latest/download/interleaf-stable-mac.json`));
    expect(info).toMatchObject({ version: '1.2.3', path: 'Interleaf-1.2.3-arm64-mac.zip', files: [{ url: 'Interleaf-1.2.3-arm64-mac.zip' }] });
    const [resolved] = feed.resolveFiles(info);
    expect(resolved?.url.href).toBe(`${RELEASES}/releases/download/v1.2.3/Interleaf-1.2.3-arm64-mac.zip`);
    expect(resolved?.info.sha512).toBe(info.files[0]?.sha512);
  });

  it('pins the Linux manifest name and carries the AppImage embedded blockmap size', async () => {
    const fetchManifest = serving(signedManifest(signer, { platform: 'linux' }));
    const info = await provider(fetchManifest, signer.trust, 'linux', 'x64').getLatestVersion();
    expect(latestManifestUrl(signer.trust, 'linux').pathname).toBe('/FrescoFlacko/interleaf-releases/releases/latest/download/interleaf-stable-linux-x64.json');
    expect(info.files).toEqual([{ url: 'Interleaf-1.2.3.AppImage', sha512: appImageEntry('1.2.3').sha512, size: 8, blockMapSize: 16 }]);
  });

  it('fails closed without a pinned key and never fetches', async () => {
    const fetchManifest = serving(signedManifest(signer));
    await expect(provider(fetchManifest, { ...UPDATE_TRUST, signingKeys: [] }).getLatestVersion()).rejects.toBeInstanceOf(UpdateNotConfiguredError);
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('pins exactly the production Ed25519 release key, whose id is its SPKI digest', () => {
    expect(UPDATE_TRUST.signingKeys).toEqual([{ keyId: 'b448deb8c896ef18', spkiBase64: 'MCowBQYDK2VwAyEAx8dTJfZRDdouR3ph4A9xRtvxlgZstXGuNiPj2v746E0=' }]);
    const [key] = UPDATE_TRUST.signingKeys;
    const der = Buffer.from(key?.spkiBase64 ?? '', 'base64');
    expect(createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('ed25519');
    expect(createHash('sha256').update(der).digest('hex').slice(0, 16)).toBe(key?.keyId);
  });

  it('reports an empty destination as no release, not as up to date', async () => {
    const feed = provider(() => Promise.resolve({ status: 'not-found' }));
    await expect(feed.getLatestVersion()).rejects.toBeInstanceOf(NoPublishedReleaseError);
  });

  it('rejects an unverified manifest before electron-updater sees any file', async () => {
    const stranger = ephemeralSigner();
    await expect(provider(serving(signedManifest(stranger))).getLatestVersion()).rejects.toBeInstanceOf(UpdateVerificationError);
  });

  it('refuses to resolve files for update info it did not verify itself', async () => {
    const feed = provider(serving(signedManifest(signer)));
    const verified = await feed.getLatestVersion();
    const substituted: UpdateInfo = { ...verified, path: 'evil.zip' };
    expect(() => feed.resolveFiles(substituted)).toThrow(/not verified/);
  });

  it('derives blockmap URLs only inside the verified tagged release', () => {
    const feed = provider(serving(''));
    const base = new URL(`${RELEASES}/releases/download/v1.2.3/Interleaf-1.2.3-arm64-mac.zip`);
    expect(feed.getBlockMapFiles(base, '1.2.2', '1.2.3').map((url) => url.href)).toEqual([
      `${RELEASES}/releases/download/v1.2.2/Interleaf-1.2.2-arm64-mac.zip.blockmap`,
      `${RELEASES}/releases/download/v1.2.3/Interleaf-1.2.3-arm64-mac.zip.blockmap`,
    ]);
    expect(() => feed.getBlockMapFiles(new URL('https://example.com/v1.2.3/a.zip'), '1.2.2', '1.2.3')).toThrow(/outside/);
    expect(() => feed.getBlockMapFiles(base, '1.2.2-beta', '1.2.3')).toThrow(/outside/);
  });
});

function response(body: string | null, init: { status?: number; url?: string } = {}): Response {
  const result = new Response(body, { status: init.status ?? 200 });
  if (init.url !== undefined) Object.defineProperty(result, 'url', { value: init.url });
  return result;
}

describe('createManifestFetcher', () => {
  const url = latestManifestUrl(UPDATE_TRUST, 'darwin');

  it('sends a credential-free, uncached GET and returns the body', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response('{"ok":1}')));
    await expect(createManifestFetcher(fetchImpl)(url)).resolves.toEqual({ status: 'found', text: '{"ok":1}' });
    const [href, init] = fetchImpl.mock.calls[0] ?? [];
    expect(href).toBe(url.href);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json' } });
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|token/i);
  });

  it('maps 404 to not-found, other statuses and transport failures to a network error', async () => {
    await expect(createManifestFetcher(() => Promise.resolve(response('', { status: 404 })))(url)).resolves.toEqual({ status: 'not-found' });
    await expect(createManifestFetcher(() => Promise.resolve(response('', { status: 503 })))(url)).rejects.toBeInstanceOf(UpdateNetworkError);
    await expect(createManifestFetcher(() => Promise.reject(new TypeError('fetch failed')))(url)).rejects.toBeInstanceOf(UpdateNetworkError);
  });

  it('refuses a redirect that downgrades to plain HTTP', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(response('{}', { url: 'http://example.com/m.json' }));
    await expect(createManifestFetcher(fetchImpl)(url)).rejects.toBeInstanceOf(UpdateNetworkError);
  });

  it('stops reading a body larger than any manifest', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(response('x'.repeat(MAX_MANIFEST_BYTES + 1)));
    await expect(createManifestFetcher(fetchImpl)(url)).rejects.toBeInstanceOf(UpdateVerificationError);
  });

  it('aborts a request that does not answer in time', async () => {
    const fetchImpl: FetchLike = (_href, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      });
    await expect(createManifestFetcher(fetchImpl, 5)(url)).rejects.toBeInstanceOf(UpdateNetworkError);
  });
});

describe('update error classification', () => {
  it('maps known failures to fixed codes and never echoes raw error text', () => {
    expect(classifyUpdateError(new UpdateNotConfiguredError(), 'check')).toBe('not-configured');
    expect(classifyUpdateError(new UpdateVerificationError('x'), 'check')).toBe('verification-failed');
    expect(classifyUpdateError(new UpdateNetworkError(), 'check')).toBe('offline');
    expect(classifyUpdateError(new Error('sha512 checksum mismatch, expected abc'), 'download')).toBe('verification-failed');
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), 'download')).toBe('offline');
    expect(classifyUpdateError(new Error('ENOTFOUND github.com'), 'install')).toBe('install-failed');
    expect(classifyUpdateError(null, 'check')).toBe('check-failed');
    expect(updateErrorMessage('download-failed')).not.toMatch(/https?:|\//);
  });

  it('logs only the error name and code', () => {
    const error = Object.assign(new Error('/Users/someone/secret at https://x'), { code: 'EACCES' });
    expect(errorLogMeta(error)).toEqual({ name: 'Error', code: 'EACCES' });
    expect(errorLogMeta(null)).toEqual({ name: 'unknown', code: null });
  });
});
