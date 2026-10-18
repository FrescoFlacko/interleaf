import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateManifestEnvelope } from '@main/updates/update-envelope';
import { verifyUpdateManifest } from '@main/updates/update-manifest';
import { RELEASE_OWNER, RELEASE_REPOSITORY, UPDATE_TRUST, manifestAssetName } from '@main/updates/update-trust';
import {
  CHECKSUMS_ASSET,
  CHECKSUMS_SIGNATURE_ASSET,
  RELEASE_REPO,
  allAssetNames,
  appImageBlockMapSize,
  builtAssetNames,
  generateSigningKey,
  ghEnvironment,
  loadSigningKey,
  parseReleaseCommand,
  promoteRelease,
  releaseAssets,
  releaseEnvironmentProblems,
  remoteProblems,
  signChecksums,
  signManifest,
  signRelease,
  stageRelease,
  verifyStage,
  type ToolResult,
} from '../../electron.update-release';
import { APPIMAGE_README_NAME, appImageReadme } from '../../electron.appimage-readme';
import { ephemeralSigner, type TestSigner } from '../helpers/update-signing';

/**
 * The release tool signs exactly what the app verifies, keeps the signing key
 * owner-only and outside the checkout, refuses incomplete or altered stage
 * directories, and only promotes a draft whose every asset it has re-downloaded
 * and re-verified. Keys are ephemeral and GitHub is a fake; nothing is uploaded.
 */

const repoRoot = join(__dirname, '../..');
const VERSION = '1.2.3';

let scratch = '';
let stage = '';
let signer: TestSigner;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'interleaf-update-release-'));
  stage = join(scratch, 'stage');
  mkdirSync(stage);
  signer = ephemeralSigner();
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** An AppImage stand-in: payload bytes, an embedded "blockmap", then its length as a big-endian UInt32. */
function fakeAppImage(blockMap = 'embedded-blockmap'): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Buffer.byteLength(blockMap));
  return Buffer.concat([Buffer.from('appimage-body'.repeat(50)), Buffer.from(blockMap), length]);
}

function stagedBytes(name: string): Buffer | string {
  if (name.endsWith('.AppImage')) return fakeAppImage();
  return name === APPIMAGE_README_NAME ? appImageReadme(releaseAssets(VERSION).appImage) : `bytes of ${name}`;
}

function stageBuiltArtifacts(): void {
  for (const name of builtAssetNames(VERSION)) writeFileSync(join(stage, name), stagedBytes(name));
}

function signStage(): void {
  stageBuiltArtifacts();
  signRelease({ stage, version: VERSION, key: signer.key, trust: signer.trust, releaseDate: '2026-10-01T12:00:00.000Z' });
}

describe('signing key bootstrap', () => {
  it('writes an owner-only Ed25519 key outside the checkout and returns only its public entry', () => {
    const directory = join(scratch, 'keys');
    const key = generateSigningKey(directory, repoRoot);
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(key.spkiBase64, 'base64')).toHaveLength(44);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(key.privateKeyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(key.privateKeyPath, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(JSON.stringify(key)).not.toContain('PRIVATE');
  });

  it('refuses a key directory inside the source checkout, including through a symlink', () => {
    expect(() => generateSigningKey(join(repoRoot, 'out', 'never-a-key-dir'), repoRoot)).toThrow(/inside the source checkout/);
    expect(existsSync(join(repoRoot, 'out', 'never-a-key-dir'))).toBe(false);
  });

  it('loads a key only when it is owner-only, outside the checkout and pinned', () => {
    const key = generateSigningKey(join(scratch, 'keys'), repoRoot);
    const pinned = { ...signer.trust, signingKeys: [{ keyId: key.keyId, spkiBase64: key.spkiBase64 }] };
    expect(loadSigningKey(key.privateKeyPath, repoRoot, pinned).keyId).toBe(key.keyId);
    expect(() => loadSigningKey(key.privateKeyPath, repoRoot, signer.trust)).toThrow(/is not pinned/);
    chmodSync(key.privateKeyPath, 0o640);
    expect(() => loadSigningKey(key.privateKeyPath, repoRoot, pinned)).toThrow(/accessible to other users/);
  });
});

describe('release signing', () => {
  it('produces manifests the app verifier accepts for every platform and architecture', () => {
    signStage();
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual([]);
    const { manifests, macZips, appImage } = releaseAssets(VERSION);
    // The app fetches each platform's manifest by exactly the name the tool stages.
    expect(manifests).toEqual({ darwin: manifestAssetName('darwin'), linux: manifestAssetName('linux') });
    const mac = readFileSync(join(stage, manifests.darwin), 'utf8');
    for (const zip of macZips) {
      const release = verifyUpdateManifest(mac, { trust: signer.trust, platform: 'darwin', arch: zip.arch });
      expect(release).toMatchObject({ version: VERSION, tag: `v${VERSION}`, file: { name: zip.name, kind: 'zip' } });
      expect(release.file.size).toBe(statSync(join(stage, zip.name)).size);
    }
    const linux = verifyUpdateManifest(readFileSync(join(stage, manifests.linux), 'utf8'), { trust: signer.trust, platform: 'linux', arch: 'x64' });
    expect(linux.file).toMatchObject({ name: appImage, kind: 'AppImage', blockMapSize: Buffer.byteLength('embedded-blockmap') });
    expect(appImageBlockMapSize(join(stage, appImage))).toBe(linux.file.blockMapSize);
    expect(readdirSync(stage).sort()).toEqual(allAssetNames(VERSION));
  });

  it('lists every other asset in a signed SHA256SUMS', () => {
    signStage();
    const lines = readFileSync(join(stage, CHECKSUMS_ASSET), 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => line.split('  ')[1])).toEqual(allAssetNames(VERSION).filter((name) => !name.startsWith(CHECKSUMS_ASSET)));
    expect(readFileSync(join(stage, CHECKSUMS_SIGNATURE_ASSET), 'utf8')).toMatch(new RegExp(`^${signer.key.keyId} [A-Za-z0-9+/]{86}==\\n$`));
  });

  it('refuses an incomplete or padded stage directory and never overwrites signed files', () => {
    stageBuiltArtifacts();
    rmSync(join(stage, releaseAssets(VERSION).appImage));
    const sign = () => { signRelease({ stage, version: VERSION, key: signer.key, trust: signer.trust, releaseDate: '2026-10-01T12:00:00.000Z' }); };
    expect(sign).toThrow(/missing Interleaf-1\.2\.3\.AppImage/);
    writeFileSync(join(stage, releaseAssets(VERSION).appImage), fakeAppImage());
    writeFileSync(join(stage, 'latest-mac.yml'), 'unsigned');
    expect(sign).toThrow(/unexpected latest-mac\.yml/);
    rmSync(join(stage, 'latest-mac.yml'));
    sign();
    expect(sign).toThrow(/unexpected/);
  });

  it('ships the AppImage README as a checksummed download that no manifest names', () => {
    signStage();
    const { appImage, downloads, manifests } = releaseAssets(VERSION);
    expect(downloads).toContain(APPIMAGE_README_NAME);
    expect(readFileSync(join(stage, APPIMAGE_README_NAME), 'utf8')).toContain(`chmod +x ~/Applications/${appImage}`);
    expect(readFileSync(join(stage, CHECKSUMS_ASSET), 'utf8')).toMatch(new RegExp(`^[0-9a-f]{64} {2}${APPIMAGE_README_NAME}$`, 'm'));
    // The updater still installs exactly the x64 AppImage; the README never enters a manifest.
    const linux = verifyUpdateManifest(readFileSync(join(stage, manifests.linux), 'utf8'), { trust: signer.trust, platform: 'linux', arch: 'x64' });
    expect(linux.file.name).toBe(appImage);
    const payload = JSON.parse(Buffer.from((JSON.parse(readFileSync(join(stage, manifests.linux), 'utf8')) as UpdateManifestEnvelope).payload, 'base64').toString('utf8')) as { files: { name: string }[] };
    expect(payload.files.map((file) => file.name)).toEqual([appImage]);
  });

  it('refuses to sign without the AppImage README or with one that is not this release\'s', () => {
    stageBuiltArtifacts();
    const sign = () => { signRelease({ stage, version: VERSION, key: signer.key, trust: signer.trust, releaseDate: '2026-10-01T12:00:00.000Z' }); };
    rmSync(join(stage, APPIMAGE_README_NAME));
    expect(sign).toThrow(`missing ${APPIMAGE_README_NAME}`);
    writeFileSync(join(stage, APPIMAGE_README_NAME), appImageReadme('Interleaf-1.2.2.AppImage'));
    expect(sign).toThrow(`${APPIMAGE_README_NAME} is not the README for Interleaf-${VERSION}.AppImage`);
    expect(readdirSync(stage)).not.toContain(CHECKSUMS_ASSET);
  });

  it('refuses a signed stage whose AppImage README is missing or altered', () => {
    signStage();
    const readme = join(stage, APPIMAGE_README_NAME);
    const original = readFileSync(readme);
    rmSync(readme);
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual([`missing ${APPIMAGE_README_NAME}`]);
    writeFileSync(readme, Buffer.concat([original, Buffer.from('Run it with --no-sandbox.\n')]));
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual([
      `${CHECKSUMS_ASSET}: ${APPIMAGE_README_NAME} does not match`,
      `${APPIMAGE_README_NAME} is not the README for Interleaf-${VERSION}.AppImage`,
    ]);
  });

  it('refuses an AppImage without an embedded blockmap', () => {
    stageBuiltArtifacts();
    writeFileSync(join(stage, releaseAssets(VERSION).appImage), Buffer.concat([Buffer.from('body'), Buffer.alloc(4)]));
    expect(() => { signRelease({ stage, version: VERSION, key: signer.key, trust: signer.trust, releaseDate: '2026-10-01T12:00:00.000Z' }); }).toThrow(/no embedded blockmap/);
  });

  it('detects an altered artifact, manifest, checksum list or foreign signing key', () => {
    signStage();
    const { macZips, manifests } = releaseAssets(VERSION);
    const zip = join(stage, macZips[0]?.name ?? '');
    const original = readFileSync(zip);
    writeFileSync(zip, Buffer.concat([original, Buffer.from('!')]));
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual(expect.arrayContaining([
      `${manifests.darwin}: ${macZips[0]?.name ?? ''} does not match its signed digest`,
      `${CHECKSUMS_ASSET}: ${macZips[0]?.name ?? ''} does not match`,
    ]));
    writeFileSync(zip, original);
    const manifestPath = join(stage, manifests.linux);
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8')) as UpdateManifestEnvelope;
    const forged = Buffer.from(envelope.payload, 'base64').toString('utf8').replace(VERSION, '1.2.4');
    writeFileSync(manifestPath, JSON.stringify({ ...envelope, payload: Buffer.from(forged).toString('base64') }));
    expect(verifyStage(stage, VERSION, signer.trust)).toContain(`${manifests.linux}: signature does not verify against a pinned key`);
    expect(verifyStage(stage, VERSION, ephemeralSigner().trust)).toEqual(expect.arrayContaining([
      `${manifests.darwin}: signature does not verify against a pinned key`,
      `${CHECKSUMS_SIGNATURE_ASSET} does not verify against a pinned key`,
    ]));
  });
});

type SignedFile = { name: string; arch: string; kind: string; size: number; sha512: string; blockMapSize?: number };
type SignedPayload = { product: string; channel: string; platform: string; tag: string; feed?: string; files: SignedFile[] };

/** Rewrites a staged manifest's payload and signs it again with the pinned test key, so only the content check can catch it. */
function resignManifest(platform: 'darwin' | 'linux', mutate: (payload: SignedPayload) => void): string {
  const name = releaseAssets(VERSION).manifests[platform];
  const envelope = JSON.parse(readFileSync(join(stage, name), 'utf8')) as UpdateManifestEnvelope;
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as SignedPayload;
  mutate(payload);
  writeFileSync(join(stage, name), signManifest(Buffer.from(JSON.stringify(payload), 'utf8'), signer.key));
  return name;
}

/** Rewrites the staged SHA256SUMS and signs it again with the pinned test key. */
function resignChecksums(mutate: (lines: string[]) => string): void {
  const lines = readFileSync(join(stage, CHECKSUMS_ASSET), 'utf8').trimEnd().split('\n');
  const text = mutate(lines);
  writeFileSync(join(stage, CHECKSUMS_ASSET), text);
  writeFileSync(join(stage, CHECKSUMS_SIGNATURE_ASSET), signChecksums(text, signer.key));
}

describe('strict release verification', () => {
  const { macZips, appImage } = releaseAssets(VERSION);
  const [arm, intel] = macZips;

  it.each<[string, 'darwin' | 'linux', (payload: SignedPayload) => void, string]>([
    ['another product', 'darwin', (payload) => { payload.product = 'com.example.other'; }, 'product is com.example.other'],
    ['another channel', 'darwin', (payload) => { payload.channel = 'beta'; }, 'malformed payload'],
    ['another platform', 'darwin', (payload) => { payload.platform = 'linux'; }, 'platform is linux'],
    ['another tag', 'linux', (payload) => { payload.tag = 'v9.9.9'; }, 'tag is v9.9.9'],
    ['an unknown field', 'linux', (payload) => { payload.feed = 'https://example.com'; }, 'malformed payload'],
    ['a swapped arch', 'darwin', (payload) => { payload.files[0]!.arch = 'x64'; }, `${arm?.name ?? ''} has the wrong arch or kind`],
    ['a wrong kind', 'darwin', (payload) => { payload.files[0]!.kind = 'AppImage'; }, `${arm?.name ?? ''} has the wrong arch or kind`],
    ['a missing architecture', 'darwin', (payload) => { payload.files = payload.files.filter((file) => file.arch === 'arm64'); }, `missing ${intel?.name ?? ''}`],
    ['an extra file', 'darwin', (payload) => { payload.files.push({ ...payload.files[0]!, name: `Interleaf-${VERSION}-arm64.dmg` }); }, `unexpected Interleaf-${VERSION}-arm64.dmg`],
    ['a duplicate file', 'darwin', (payload) => { payload.files.push({ ...payload.files[0]! }); }, 'duplicate file entries'],
    ['a wrong blockmap size', 'linux', (payload) => { payload.files[0]!.blockMapSize = 1; }, `${appImage} has the wrong blockmap size`],
    ['a missing blockmap size', 'linux', (payload) => { delete payload.files[0]!.blockMapSize; }, `${appImage} has the wrong blockmap size`],
    ['a blockmap size on a zip', 'darwin', (payload) => { payload.files[1]!.blockMapSize = 7; }, `${intel?.name ?? ''} has the wrong blockmap size`],
  ])('rejects a correctly signed manifest with %s', (_label, platform, mutate, problem) => {
    signStage();
    const name = resignManifest(platform, mutate);
    expect(verifyStage(stage, VERSION, signer.trust)).toContain(`${name}: ${problem}`);
  });

  it('rejects a stage holding any manifest beyond the two expected ones', () => {
    signStage();
    writeFileSync(join(stage, 'interleaf-stable-linux-arm64.json'), readFileSync(join(stage, releaseAssets(VERSION).manifests.linux)));
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual(['unexpected interleaf-stable-linux-arm64.json']);
  });

  it.each<[string, (lines: string[]) => string, string]>([
    ['a duplicate entry', (lines) => `${[...lines, lines[0]!].sort().join('\n')}\n`, 'duplicate entries'],
    ['a missing entry', (lines) => `${lines.filter((line) => !line.endsWith(appImage)).join('\n')}\n`, `missing ${appImage}`],
    ['an unknown name', (lines) => `${[...lines, `${'0'.repeat(64)}  extra.bin`].sort().join('\n')}\n`, 'unexpected extra.bin'],
    ['a traversal name', (lines) => `${lines.map((line) => line.replace(`  ${appImage}`, `  ../${appImage}`)).join('\n')}\n`, 'malformed line'],
    ['an entry for itself', (lines) => `${[...lines, `${'0'.repeat(64)}  ${CHECKSUMS_ASSET}`].sort().join('\n')}\n`, `unexpected ${CHECKSUMS_ASSET}`],
    ['a malformed digest', (lines) => `${lines.map((line, index) => (index === 0 ? line.replace(/^[0-9a-f]{64}/, (digest) => digest.toUpperCase()) : line)).join('\n')}\n`, 'malformed line'],
    ['a short digest', (lines) => `${lines.map((line, index) => (index === 0 ? line.slice(2) : line)).join('\n')}\n`, 'malformed line'],
    ['a single-space separator', (lines) => `${lines.map((line, index) => (index === 0 ? line.replace('  ', ' ') : line)).join('\n')}\n`, 'malformed line'],
    ['unsorted entries', (lines) => `${[...lines].reverse().join('\n')}\n`, 'entries are not sorted'],
    ['no final newline', (lines) => lines.join('\n'), 'does not end with a newline'],
  ])('rejects a correctly signed SHA256SUMS with %s', (_label, mutate, problem) => {
    signStage();
    resignChecksums(mutate);
    expect(verifyStage(stage, VERSION, signer.trust).join('\n')).toContain(problem);
  });

  it('accepts the canonical SHA256SUMS that signing writes', () => {
    signStage();
    resignChecksums((lines) => `${lines.join('\n')}\n`);
    expect(verifyStage(stage, VERSION, signer.trust)).toEqual([]);
  });
});

type GhCall = readonly string[];

/** A GitHub stand-in holding one release whose assets are copies of `source`. */
function fakeGitHub(source: string, state: { draft: boolean; exists: boolean; tamper?: string }) {
  const calls: GhCall[] = [];
  const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' });
  const gh = (args: readonly string[]): ToolResult => {
    calls.push(args);
    const [group, action] = args;
    if (group === 'release' && action === 'view') {
      if (!state.exists) return { status: 1, stdout: '', stderr: 'release not found' };
      const assets = readdirSync(source).map((name) => ({ name, size: statSync(join(source, name)).size }));
      return ok(JSON.stringify({ tagName: `v${VERSION}`, isDraft: state.draft, isPrerelease: false, assets }));
    }
    if (group === 'release' && action === 'create') {
      state.exists = true;
      return ok();
    }
    if (group === 'release' && action === 'download') {
      const target = args[args.indexOf('--dir') + 1] ?? '';
      cpSync(source, target, { recursive: true });
      if (state.tamper !== undefined) writeFileSync(join(target, state.tamper), 'swapped on the server');
      return ok();
    }
    if (group === 'release' && action === 'edit') {
      state.draft = false;
      return ok();
    }
    if (group === 'api') return ok(state.draft ? '' : `v${VERSION}\n`);
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { gh, calls };
}

describe('draft-first GitHub release', () => {
  it('creates only a draft in the releases repository, then verifies it from a fresh download', () => {
    signStage();
    const github = fakeGitHub(stage, { draft: true, exists: false });
    expect(stageRelease(stage, VERSION, signer.trust, 'notes', github.gh)).toEqual([]);
    const create = github.calls.find((call) => call[1] === 'create') ?? [];
    expect(create.slice(0, 6)).toEqual(['release', 'create', `v${VERSION}`, '--repo', RELEASE_REPO, '--draft']);
    expect(RELEASE_REPO).toBe('FrescoFlacko/interleaf-releases');
    // The tool publishes to the same repository the app's pinned anchor reads from.
    expect(RELEASE_REPO).toBe(`${RELEASE_OWNER}/${RELEASE_REPOSITORY}`);
    expect(UPDATE_TRUST.repositoryPath).toBe(`/${RELEASE_REPO}`);
    expect(create.filter((arg) => arg.startsWith(stage))).toHaveLength(allAssetNames(VERSION).length);
    expect(github.calls.some((call) => call.includes('--latest'))).toBe(false);
  });

  it('refuses to stage over an existing release or from an unverified stage', () => {
    signStage();
    expect(stageRelease(stage, VERSION, signer.trust, 'notes', fakeGitHub(stage, { draft: true, exists: true }).gh)).toEqual([
      `${RELEASE_REPO} already has a release for v${VERSION}; inspect it instead of overwriting it.`,
    ]);
    const github = fakeGitHub(stage, { draft: true, exists: false });
    expect(stageRelease(stage, VERSION, ephemeralSigner().trust, 'notes', github.gh)).not.toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it('refuses a draft whose downloaded bytes differ from the stage', () => {
    signStage();
    const { appImage } = releaseAssets(VERSION);
    const github = fakeGitHub(stage, { draft: true, exists: true, tamper: appImage });
    expect(remoteProblems(stage, VERSION, signer.trust, true, github.gh)).toContain(`${appImage} downloaded from GitHub differs from the staged file`);
  });

  it('refuses a draft whose downloaded AppImage README differs from the stage', () => {
    signStage();
    const github = fakeGitHub(stage, { draft: true, exists: true, tamper: APPIMAGE_README_NAME });
    expect(remoteProblems(stage, VERSION, signer.trust, true, github.gh)).toContain(`${APPIMAGE_README_NAME} downloaded from GitHub differs from the staged file`);
  });

  it('refuses a draft with a missing asset before downloading anything', () => {
    signStage();
    const remote = join(scratch, 'remote');
    cpSync(stage, remote, { recursive: true });
    rmSync(join(remote, CHECKSUMS_SIGNATURE_ASSET));
    const github = fakeGitHub(remote, { draft: true, exists: true });
    expect(remoteProblems(stage, VERSION, signer.trust, true, github.gh)).toEqual([`missing ${CHECKSUMS_SIGNATURE_ASSET}`]);
    expect(github.calls.some((call) => call[1] === 'download')).toBe(false);
  });

  it('promotes only a verified draft, then checks the published release is the latest', () => {
    signStage();
    const github = fakeGitHub(stage, { draft: true, exists: true });
    expect(promoteRelease(stage, VERSION, signer.trust, github.gh)).toEqual([]);
    expect(github.calls.find((call) => call[1] === 'edit')).toEqual([
      'release', 'edit', `v${VERSION}`, '--repo', RELEASE_REPO, '--draft=false', '--prerelease=false', '--latest',
    ]);
    const tampered = fakeGitHub(stage, { draft: true, exists: true, tamper: releaseAssets(VERSION).manifests.darwin });
    expect(promoteRelease(stage, VERSION, signer.trust, tampered.gh)).not.toEqual([]);
    expect(tampered.calls.some((call) => call[1] === 'edit')).toBe(false);
  });

  it('passes the GitHub CLI only what it needs to find its own login', () => {
    expect(ghEnvironment({ HOME: '/h', PATH: '/bin', GH_TOKEN: 't', APPLE_KEYCHAIN_PROFILE: 'p', AWS_SECRET_ACCESS_KEY: 's' })).toEqual({
      HOME: '/h', PATH: '/bin', GH_TOKEN: 't',
    });
  });
});

describe('command line', () => {
  it('accepts each command with only its own flags', () => {
    expect(parseReleaseCommand(['keygen'])).toEqual({ command: 'keygen', flags: new Map() });
    expect(parseReleaseCommand(['sign', '--key', '/k.pem', '--stage', '/s']).flags.get('--key')).toBe('/k.pem');
    expect(() => parseReleaseCommand(['publish'])).toThrow(/Unknown command/);
    expect(() => parseReleaseCommand(['sign', '--stage', '/s'])).toThrow(/needs --key/);
    expect(() => parseReleaseCommand(['verify', '--stage', '/a', '--stage', '/b'])).toThrow(/repeated/);
    expect(() => parseReleaseCommand(['promote', '--stage', '/s', '--token', 'x'])).toThrow(/Unsupported/);
  });

  it('refuses to run in a shell that builds update smoke packages', () => {
    expect(releaseEnvironmentProblems({ HOME: '/home/someone' })).toEqual([]);
    expect(releaseEnvironmentProblems({ INTERLEAF_UPDATE_SMOKE_TRUST: '' })).toEqual([expect.stringContaining('INTERLEAF_UPDATE_SMOKE_TRUST')]);
  });
});
