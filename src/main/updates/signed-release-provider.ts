import { Provider, type AppUpdater, type MacUpdater, type ResolvedUpdateFileInfo, type UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { STABLE_VERSION_PATTERN } from '@shared/schemas/updates';
import { verifyUpdateManifest, type ManifestExpectation, type VerifiedRelease } from './update-manifest';
import { latestManifestUrl, taggedAssetUrl } from './update-trust';

/**
 * electron-updater's update source, restricted to signed stable releases.
 *
 * electron-updater 6.8.9 has no signed-metadata support of its own, so this
 * custom provider is the trust boundary: it reads only the signed manifest at
 * the fixed release origin, verifies it against the pinned keys, and hands
 * electron-updater an `UpdateInfo` built solely from the verified statement —
 * one file, for this architecture, with its SHA-512 and size. Every URL it
 * produces is derived from the verified tag and file name on the same fixed
 * origin. electron-updater keeps doing the transfer, the SHA-512 check of
 * full, cached and differential downloads, and the platform install.
 *
 * `resolveFiles` refuses any `UpdateInfo` this provider did not itself
 * produce from a verified manifest, so nothing can be substituted between the
 * check and the download.
 */

type ManifestFetchResult = { readonly status: 'found'; readonly text: string } | { readonly status: 'not-found' };
/** Fetches one manifest with a hard size limit; rejects with an `UpdateNetworkError` when the origin is unreachable. */
export type ManifestFetcher = (url: URL) => Promise<ManifestFetchResult>;

/** The destination answered, but it has no published stable release carrying a manifest yet. */
export class NoPublishedReleaseError extends Error {
  constructor() {
    super('No stable release has been published yet.');
    this.name = 'NoPublishedReleaseError';
  }
}

/** The release destination could not be reached at all. */
export class UpdateNetworkError extends Error {
  constructor(message = 'The release destination could not be reached.') {
    super(message);
    this.name = 'UpdateNetworkError';
  }
}

/** This build pins no update-signing key, so no manifest could ever be trusted. */
export class UpdateNotConfiguredError extends Error {
  constructor() {
    super('This build has no update-signing key.');
    this.name = 'UpdateNotConfiguredError';
  }
}

export type SignedProviderConfig = ManifestExpectation & { readonly fetchManifest: ManifestFetcher };

/** The `custom` feed options electron-updater's updaters accept. */
export type SignedFeedOptions = Extract<NonNullable<ConstructorParameters<typeof MacUpdater>[0]>, { readonly provider: 'custom' }>;

export class SignedReleaseProvider extends Provider<UpdateInfo> {
  private readonly verified = new WeakMap<UpdateInfo, VerifiedRelease>();

  constructor(
    private readonly config: SignedProviderConfig,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const { trust, platform } = this.config;
    if (trust.signingKeys.length === 0) throw new UpdateNotConfiguredError();
    const fetched = await this.config.fetchManifest(latestManifestUrl(trust, platform));
    if (fetched.status === 'not-found') throw new NoPublishedReleaseError();
    const release = verifyUpdateManifest(fetched.text, this.config);
    const { file } = release;
    const fileInfo = {
      url: file.name,
      sha512: file.sha512,
      size: file.size,
      ...(file.blockMapSize === undefined ? {} : { blockMapSize: file.blockMapSize }),
    };
    const info: UpdateInfo = {
      version: release.version,
      releaseDate: release.releaseDate,
      files: [fileInfo],
      path: file.name,
      sha512: file.sha512,
    };
    this.verified.set(info, release);
    return info;
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    const release = this.verified.get(updateInfo);
    if (release === undefined) throw new Error('Refusing update metadata that was not verified by this provider.');
    const { file } = release;
    return [
      {
        url: taggedAssetUrl(this.config.trust, release.tag, file.name),
        info: {
          url: file.name,
          sha512: file.sha512,
          size: file.size,
          ...(file.blockMapSize === undefined ? {} : { blockMapSize: file.blockMapSize }),
        },
      },
    ];
  }

  /**
   * Blockmaps only plan which byte ranges to fetch; the reassembled file must
   * still match the signed SHA-512. Both are fixed-origin tagged assets.
   */
  override getBlockMapFiles(baseUrl: URL, oldVersion: string, newVersion: string): URL[] {
    const { trust } = this.config;
    const expectedPrefix = new URL(`${trust.repositoryPath}/releases/download/v${newVersion}/`, trust.origin).href;
    if (!STABLE_VERSION_PATTERN.test(oldVersion) || !STABLE_VERSION_PATTERN.test(newVersion) || !baseUrl.href.startsWith(expectedPrefix)) {
      throw new Error('Refusing a blockmap outside the verified release.');
    }
    const name = decodeURIComponent(baseUrl.pathname.slice(baseUrl.pathname.lastIndexOf('/') + 1));
    const oldName = name.split(newVersion).join(oldVersion);
    return [taggedAssetUrl(trust, `v${oldVersion}`, `${oldName}.blockmap`), taggedAssetUrl(trust, `v${newVersion}`, `${name}.blockmap`)];
  }
}

/** Feed options that make an electron-updater updater use only the signed provider. */
export function signedFeedOptions(config: SignedProviderConfig): SignedFeedOptions {
  class BoundSignedReleaseProvider extends SignedReleaseProvider {
    constructor(_options: SignedFeedOptions, _updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
      super(config, runtimeOptions);
    }
  }
  return { provider: 'custom', updateProvider: BoundSignedReleaseProvider };
}
