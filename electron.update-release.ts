import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type * as Readme from './electron.appimage-readme';
import type * as Envelope from './src/main/updates/update-envelope';
import type * as Trust from './src/main/updates/update-trust';

/**
 * Node runs this file with type stripping, which needs the `.ts` extension on a
 * relative import; the TypeScript config rejects that extension in a static
 * specifier, so the sibling modules are loaded dynamically and typed
 * statically. Both import nothing but `node:crypto`, so this tool signs with
 * exactly the envelope format and pinned trust the app verifies against.
 */
const envelopeModule = './src/main/updates/update-envelope.ts';
const trustModule = './src/main/updates/update-trust.ts';
const readmeModule = './electron.appimage-readme.ts';
const { UPDATE_MANIFEST_FORMAT, payloadSignatureValid, pinnedKey, signedMessage, signingKeyId } = (await import(envelopeModule)) as typeof Envelope;
const { UPDATE_TRUST, RELEASE_OWNER, RELEASE_REPOSITORY, manifestAssetName } = (await import(trustModule)) as typeof Trust;
const { APPIMAGE_README_NAME, appImageReadme } = (await import(readmeModule)) as typeof Readme;

/**
 * Stable update releases: key bootstrap, manifest signing, and a draft-first
 * GitHub release that is verified in full before it becomes `latest`.
 *
 *   node electron.update-release.ts keygen [--dir <owner-only directory>]
 *   node electron.update-release.ts sign --key <private key> --stage <dir>
 *   node electron.update-release.ts verify --stage <dir>
 *   node electron.update-release.ts stage --stage <dir>
 *   node electron.update-release.ts verify-draft --stage <dir>
 *   node electron.update-release.ts promote --stage <dir>
 *
 * The signing key never enters the repository, an artifact, the stage
 * directory or a log: `keygen` writes it with owner-only permissions to a
 * directory outside the checkout and prints only the public entry to pin in
 * src/main/updates/update-trust.ts, and `sign` refuses a key that is readable
 * by others, lives inside the checkout or is not pinned by this source tree.
 * Uploads go through the GitHub CLI's own authentication; no token is read,
 * stored or passed here. Nothing is published unless `stage` and `promote`
 * are run explicitly, and `promote` re-verifies the draft first.
 */

type UpdateTrust = Trust.UpdateTrust;
type Environment = Readonly<Record<string, string | undefined>>;

export const RELEASE_REPO = `${RELEASE_OWNER}/${RELEASE_REPOSITORY}`;
export const CHECKSUMS_ASSET = 'SHA256SUMS';
export const CHECKSUMS_SIGNATURE_ASSET = 'SHA256SUMS.sig';
/** Domain separation for the checksum-list signature, distinct from the manifest domain. */
export const CHECKSUMS_SIGNATURE_DOMAIN = 'interleaf-sha256sums/v1\n';
const PRODUCT_NAME = 'Interleaf';
const PACKAGE_NAME = 'interleaf';
const GH_DEADLINE_MS = 30 * 60 * 1000;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type ReleaseAssets = {
  readonly macZips: readonly { readonly arch: 'arm64' | 'x64'; readonly name: string }[];
  readonly appImage: string;
  /** Uploaded and checksummed, but not installed by the updater. */
  readonly downloads: readonly string[];
  readonly manifests: { readonly darwin: string; readonly linux: string };
};

/** electron-builder 26.15.3's default artifact names for this configuration (see electron-builder.yml). */
export function releaseAssets(version: string): ReleaseAssets {
  const macZips = [
    { arch: 'arm64', name: `${PRODUCT_NAME}-${version}-arm64-mac.zip` },
    { arch: 'x64', name: `${PRODUCT_NAME}-${version}-mac.zip` },
  ] as const;
  return {
    macZips,
    appImage: `${PRODUCT_NAME}-${version}.AppImage`,
    downloads: [
      `${PRODUCT_NAME}-${version}-arm64.dmg`,
      `${PRODUCT_NAME}-${version}.dmg`,
      ...macZips.map((zip) => `${zip.name}.blockmap`),
      `${PACKAGE_NAME}_${version}_amd64.deb`,
      `${PACKAGE_NAME}-${version}-x64.pkg.tar.xz`,
      APPIMAGE_README_NAME,
    ],
    manifests: { darwin: manifestAssetName('darwin'), linux: manifestAssetName('linux') },
  };
}

/** Artifacts the release build produces, which must all be in the stage directory before signing. */
export function builtAssetNames(version: string): string[] {
  const assets = releaseAssets(version);
  return [...assets.macZips.map((zip) => zip.name), assets.appImage, ...assets.downloads].sort();
}

/** The complete, exact asset set of a release. */
export function allAssetNames(version: string): string[] {
  const { manifests } = releaseAssets(version);
  return [...builtAssetNames(version), manifests.darwin, manifests.linux, CHECKSUMS_ASSET, CHECKSUMS_SIGNATURE_ASSET].sort();
}

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Canonical path of `path`, or of its nearest existing ancestor joined with the rest, so symlinks cannot hide a location. */
function canonicalTarget(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalTarget(parent), relative(parent, absolute));
}

export function defaultKeyDirectory(env: Environment = process.env): string {
  return join(env.HOME ?? homedir(), '.config', 'interleaf-release-signing');
}

function ownerOnlyProblem(path: string, mask: number): string | undefined {
  const stats = statSync(path);
  if ((stats.mode & mask) !== 0) return `${path} is accessible to other users (mode ${(stats.mode & 0o777).toString(8)})`;
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return `${path} is not owned by the current user`;
  return undefined;
}

export type GeneratedKey = { readonly keyId: string; readonly spkiBase64: string; readonly privateKeyPath: string };

/** Creates an Ed25519 signing key in an owner-only directory outside `repoRoot`; never overwrites a key. */
export function generateSigningKey(directory: string, repoRoot: string): GeneratedKey {
  const target = canonicalTarget(directory);
  if (isInside(realpathSync(repoRoot), target)) throw new Error(`${target} is inside the source checkout; keep the signing key outside it.`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const unsafe = ownerOnlyProblem(target, 0o077);
  if (unsafe !== undefined) throw new Error(unsafe);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = signingKeyId(spki);
  const privateKeyPath = join(target, `update-signing-${keyId}.pem`);
  writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  return { keyId, spkiBase64: spki.toString('base64'), privateKeyPath };
}

export type SigningKey = { readonly keyId: string; readonly privateKey: KeyObject };

/** Loads the private key only if it is owner-only, outside the checkout, Ed25519 and pinned by `trust`. */
export function loadSigningKey(path: string, repoRoot: string, trust: UpdateTrust): SigningKey {
  const canonical = realpathSync(path);
  if (isInside(realpathSync(repoRoot), canonical)) throw new Error('The signing key is inside the source checkout; move it out and rotate it.');
  const unsafe = ownerOnlyProblem(canonical, 0o077);
  if (unsafe !== undefined) throw new Error(unsafe);
  const privateKey = createPrivateKey(readFileSync(canonical));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not an Ed25519 key.');
  const keyId = signingKeyId(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }));
  if (pinnedKey(trust.signingKeys, keyId) === undefined) {
    throw new Error(`Key ${keyId} is not pinned in src/main/updates/update-trust.ts, so no build would accept what it signs.`);
  }
  return { keyId, privateKey };
}

export type FileFacts = { readonly size: number; readonly sha512: string; readonly sha256: string };

/** Size and digests of a file, read in bounded chunks. */
export function fileFacts(path: string): FileFacts {
  const sha512 = createHash('sha512');
  const sha256 = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let read = 0;
    while ((read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      sha512.update(buffer.subarray(0, read));
      sha256.update(buffer.subarray(0, read));
    }
    return { size: fstatSync(descriptor).size, sha512: sha512.digest('base64'), sha256: sha256.digest('hex') };
  } finally {
    closeSync(descriptor);
  }
}

/** electron-builder appends the AppImage's blockmap followed by its length as a big-endian UInt32. */
export function appImageBlockMapSize(path: string): number {
  const descriptor = openSync(path, 'r');
  try {
    const { size } = fstatSync(descriptor);
    const tail = Buffer.alloc(4);
    if (size < 8 || readSync(descriptor, tail, 0, 4, size - 4) !== 4) throw new Error(`${path} is too small to be an AppImage.`);
    const blockMapSize = tail.readUInt32BE(0);
    if (blockMapSize === 0 || blockMapSize > size - 4) throw new Error(`${path} carries no embedded blockmap.`);
    return blockMapSize;
  } finally {
    closeSync(descriptor);
  }
}

export type ManifestFile = {
  readonly name: string;
  readonly arch: 'arm64' | 'x64';
  readonly kind: 'zip' | 'AppImage';
  readonly size: number;
  readonly sha512: string;
  readonly blockMapSize?: number;
};

export type ManifestInput = {
  readonly trust: UpdateTrust;
  readonly platform: 'darwin' | 'linux';
  readonly version: string;
  readonly releaseDate: string;
  readonly files: readonly ManifestFile[];
};

/** The exact payload bytes a manifest signs; field order is fixed so the bytes are reproducible. */
export function manifestPayload(input: ManifestInput): Buffer {
  const payload = {
    schemaVersion: 1,
    product: input.trust.product,
    channel: 'stable',
    platform: input.platform,
    version: input.version,
    tag: `v${input.version}`,
    releaseDate: input.releaseDate,
    files: input.files,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function signManifest(payload: Buffer, key: SigningKey): string {
  const signature = sign(null, signedMessage(payload), key.privateKey);
  const envelope: Envelope.UpdateManifestEnvelope = {
    format: UPDATE_MANIFEST_FORMAT,
    keyId: key.keyId,
    payload: payload.toString('base64'),
    signature: signature.toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function checksumsText(facts: ReadonlyMap<string, FileFacts>): string {
  return [...facts.keys()]
    .sort()
    .map((name) => `${facts.get(name)?.sha256 ?? ''}  ${name}\n`)
    .join('');
}

const checksumsMessage = (text: string): Buffer => Buffer.concat([Buffer.from(CHECKSUMS_SIGNATURE_DOMAIN, 'utf8'), Buffer.from(text, 'utf8')]);

/** `SHA256SUMS.sig`: the signing key id and a detached Ed25519 signature over the domain-prefixed list. */
export function signChecksums(text: string, key: SigningKey): string {
  return `${key.keyId} ${sign(null, checksumsMessage(text), key.privateKey).toString('base64')}\n`;
}

/** Stage-directory file names, failing on anything that is not a regular file. */
function stagedNames(stage: string): string[] {
  return readdirSync(stage, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) throw new Error(`${join(stage, entry.name)} is not a regular file.`);
    return entry.name;
  });
}

function setDifference(expected: readonly string[], actual: readonly string[]): string[] {
  const missing = expected.filter((name) => !actual.includes(name)).map((name) => `missing ${name}`);
  const extra = actual.filter((name) => !expected.includes(name)).map((name) => `unexpected ${name}`);
  return [...missing, ...extra];
}

export type SignOptions = {
  readonly stage: string;
  readonly version: string;
  readonly key: SigningKey;
  readonly trust: UpdateTrust;
  readonly releaseDate: string;
};

/** Writes both signed manifests, `SHA256SUMS` and its signature for a complete stage directory. */
export function signRelease(options: SignOptions): void {
  const { stage, version, key, trust, releaseDate } = options;
  const problems = setDifference(builtAssetNames(version), stagedNames(stage));
  if (problems.length > 0) throw new Error(`The stage directory must hold exactly the built artifacts: ${problems.join('; ')}`);
  const readme = readmeProblems(stage, version);
  if (readme.length > 0) throw new Error(readme.join('; '));
  const assets = releaseAssets(version);
  const facts = new Map(builtAssetNames(version).map((name) => [name, fileFacts(join(stage, name))]));
  const fileEntry = (name: string, arch: 'arm64' | 'x64', kind: 'zip' | 'AppImage', blockMapSize?: number): ManifestFile => {
    const { size, sha512 } = facts.get(name) ?? fileFacts(join(stage, name));
    return blockMapSize === undefined ? { name, arch, kind, size, sha512 } : { name, arch, kind, size, sha512, blockMapSize };
  };
  const manifests = {
    [assets.manifests.darwin]: manifestPayload({ trust, platform: 'darwin', version, releaseDate, files: assets.macZips.map((zip) => fileEntry(zip.name, zip.arch, 'zip')) }),
    [assets.manifests.linux]: manifestPayload({
      trust,
      platform: 'linux',
      version,
      releaseDate,
      files: [fileEntry(assets.appImage, 'x64', 'AppImage', appImageBlockMapSize(join(stage, assets.appImage)))],
    }),
  };
  for (const [name, payload] of Object.entries(manifests)) {
    writeFileSync(join(stage, name), signManifest(payload, key), { flag: 'wx' });
    facts.set(name, fileFacts(join(stage, name)));
  }
  const checksums = checksumsText(facts);
  writeFileSync(join(stage, CHECKSUMS_ASSET), checksums, { flag: 'wx' });
  writeFileSync(join(stage, CHECKSUMS_SIGNATURE_ASSET), signChecksums(checksums, key), { flag: 'wx' });
}

const envelopeSchema = z.object({ format: z.literal(UPDATE_MANIFEST_FORMAT), keyId: z.string(), payload: z.string(), signature: z.string() }).strict();
const signedFileSchema = z
  .object({
    name: z.string(),
    arch: z.enum(['arm64', 'x64']),
    kind: z.enum(['zip', 'AppImage']),
    size: z.number().int().positive(),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    blockMapSize: z.number().int().positive().optional(),
  })
  .strict();
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.string(),
    channel: z.literal('stable'),
    platform: z.enum(['darwin', 'linux']),
    version: z.string(),
    tag: z.string(),
    releaseDate: z.iso.datetime(),
    files: z.array(signedFileSchema),
  })
  .strict();

/** Parsed JSON, or `null` for text that is not JSON (callers then report it as malformed). */
function parseJsonOrNull(text: string): z.core.util.JSONType {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return null;
  }
}

type ExpectedFile = { readonly name: string; readonly arch: 'arm64' | 'x64'; readonly kind: 'zip' | 'AppImage' };

/** The exact files a platform's manifest must name: every macOS architecture, or the x64 AppImage. */
function expectedManifestFiles(platform: 'darwin' | 'linux', version: string): ExpectedFile[] {
  const assets = releaseAssets(version);
  if (platform === 'darwin') return assets.macZips.map((zip) => ({ name: zip.name, arch: zip.arch, kind: 'zip' }));
  return [{ name: assets.appImage, arch: 'x64', kind: 'AppImage' }];
}

/** Problems with one file entry: identity, presence in the stage, and the staged bytes it signs. */
function signedFileProblems(stage: string, manifest: string, file: z.infer<typeof signedFileSchema>, expected: ExpectedFile): string[] {
  if (file.arch !== expected.arch || file.kind !== expected.kind) return [`${manifest}: ${file.name} has the wrong arch or kind`];
  const path = join(stage, file.name);
  if (!existsSync(path)) return [`${manifest}: names ${file.name}, which is not staged`];
  const facts = fileFacts(path);
  if (facts.size !== file.size || facts.sha512 !== file.sha512) return [`${manifest}: ${file.name} does not match its signed digest`];
  const blockMapSize = expected.kind === 'AppImage' ? appImageBlockMapSize(path) : undefined;
  return file.blockMapSize === blockMapSize ? [] : [`${manifest}: ${file.name} has the wrong blockmap size`];
}

/**
 * Problems with one staged manifest: a signature by a pinned key, then the
 * strict payload the app accepts — product, stable channel, platform, version,
 * tag — naming exactly this platform's expected files, one per architecture,
 * each matching the staged bytes.
 */
function manifestProblems(stage: string, platform: 'darwin' | 'linux', version: string, trust: UpdateTrust): string[] {
  const name = manifestAssetName(platform);
  const envelope = envelopeSchema.safeParse(parseJsonOrNull(readFileSync(join(stage, name), 'utf8')));
  if (!envelope.success) return [`${name}: malformed envelope`];
  const key = pinnedKey(trust.signingKeys, envelope.data.keyId);
  const payload = Buffer.from(envelope.data.payload, 'base64');
  if (key === undefined || !payloadSignatureValid(payload, Buffer.from(envelope.data.signature, 'base64'), key)) {
    return [`${name}: signature does not verify against a pinned key`];
  }
  const parsed = payloadSchema.safeParse(parseJsonOrNull(payload.toString('utf8')));
  if (!parsed.success) return [`${name}: malformed payload`];
  const signed = parsed.data;
  const identity = [
    signed.product === trust.product ? '' : `product is ${signed.product}`,
    signed.platform === platform ? '' : `platform is ${signed.platform}`,
    signed.version === version ? '' : `payload is not for ${version}`,
    signed.tag === `v${version}` ? '' : `tag is ${signed.tag}`,
  ].filter((problem) => problem !== '');
  if (identity.length > 0) return identity.map((problem) => `${name}: ${problem}`);
  const expected = expectedManifestFiles(platform, version);
  const names = signed.files.map((file) => file.name);
  const listProblems = setDifference(expected.map((file) => file.name), names);
  if (new Set(names).size !== names.length) listProblems.push('duplicate file entries');
  if (listProblems.length > 0) return listProblems.map((problem) => `${name}: ${problem}`);
  return signed.files.flatMap((file) => {
    const match = expected.find((candidate) => candidate.name === file.name);
    return match === undefined ? [] : signedFileProblems(stage, name, file, match);
  });
}

const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Problems with the signed checksum list: its signature, then exactly one
 * canonical `<sha256>  <name>` line, in sorted order, for every release asset
 * except the list and its signature — no duplicate, unknown, malformed or
 * path-like entry — each matching the staged bytes.
 */
function checksumProblems(stage: string, version: string, trust: UpdateTrust): string[] {
  const text = readFileSync(join(stage, CHECKSUMS_ASSET), 'utf8');
  const [keyId = '', signature = '', ...rest] = readFileSync(join(stage, CHECKSUMS_SIGNATURE_ASSET), 'utf8').trim().split(' ');
  const key = rest.length === 0 ? pinnedKey(trust.signingKeys, keyId) : undefined;
  if (key === undefined || !verify(null, checksumsMessage(text), key, Buffer.from(signature, 'base64'))) {
    return [`${CHECKSUMS_SIGNATURE_ASSET} does not verify against a pinned key`];
  }
  if (!text.endsWith('\n')) return [`${CHECKSUMS_ASSET} does not end with a newline`];
  const expected = allAssetNames(version).filter((name) => name !== CHECKSUMS_ASSET && name !== CHECKSUMS_SIGNATURE_ASSET);
  const entries: { readonly digest: string; readonly name: string }[] = [];
  const problems: string[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const match = CHECKSUM_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) problems.push(`${CHECKSUMS_ASSET}: malformed line`);
    else entries.push({ digest: match[1], name: match[2] });
  }
  const names = entries.map((entry) => entry.name);
  problems.push(...setDifference(expected, names).map((problem) => `${CHECKSUMS_ASSET}: ${problem}`));
  if (new Set(names).size !== names.length) problems.push(`${CHECKSUMS_ASSET}: duplicate entries`);
  if (problems.length === 0 && names.join('\n') !== [...names].sort().join('\n')) problems.push(`${CHECKSUMS_ASSET}: entries are not sorted`);
  if (problems.length > 0) return problems;
  return entries.flatMap(({ digest, name }) => (fileFacts(join(stage, name)).sha256 === digest ? [] : [`${CHECKSUMS_ASSET}: ${name} does not match`]));
}

/** The staged AppImage README must be exactly the one this source renders for the release's AppImage. */
function readmeProblems(stage: string, version: string): string[] {
  const { appImage } = releaseAssets(version);
  return readFileSync(join(stage, APPIMAGE_README_NAME), 'utf8') === appImageReadme(appImage) ? [] : [`${APPIMAGE_README_NAME} is not the README for ${appImage}`];
}

/** Every problem with a stage directory: the exact asset set, both manifests, the signed checksum list and the AppImage README. */
export function verifyStage(stage: string, version: string, trust: UpdateTrust): string[] {
  const setProblems = setDifference(allAssetNames(version), stagedNames(stage));
  if (setProblems.length > 0) return setProblems;
  return [
    ...manifestProblems(stage, 'darwin', version, trust),
    ...manifestProblems(stage, 'linux', version, trust),
    ...checksumProblems(stage, version, trust),
    ...readmeProblems(stage, version),
  ];
}

export type ToolResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
/** Runs the GitHub CLI with tokenized arguments. */
export type GhRunner = (args: readonly string[]) => ToolResult;

/** What the GitHub CLI needs to find its own login; nothing else from the caller's environment is passed. */
const GH_ENVIRONMENT = ['HOME', 'PATH', 'LANG', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSL_CERT_FILE'] as const;

export function ghEnvironment(env: Environment): Record<string, string> {
  return Object.fromEntries(GH_ENVIRONMENT.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

const runGh: GhRunner = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', shell: false, timeout: GH_DEADLINE_MS, maxBuffer: 16 * 1024 * 1024, env: ghEnvironment(process.env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const releaseViewSchema = z
  .object({
    tagName: z.string(),
    isDraft: z.boolean(),
    isPrerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), size: z.number() }).loose()),
  })
  .loose();

function ghFailure(action: string, result: ToolResult): string {
  return `${action} failed (exit ${String(result.status)}): ${result.stderr.trim().split('\n', 1)[0] ?? ''}`;
}

/**
 * Every problem with the release on GitHub: its state, its exact asset names
 * and sizes, and a fresh download of every asset that must hash to the staged
 * bytes and pass the full stage verification on its own.
 */
export function remoteProblems(stage: string, version: string, trust: UpdateTrust, expectDraft: boolean, gh: GhRunner = runGh): string[] {
  const tag = `v${version}`;
  const viewed = gh(['release', 'view', tag, '--repo', RELEASE_REPO, '--json', 'tagName,isDraft,isPrerelease,assets']);
  if (viewed.status !== 0) return [ghFailure(`gh release view ${tag}`, viewed)];
  const release = releaseViewSchema.safeParse(parseJsonOrNull(viewed.stdout));
  if (!release.success) return ['gh release view returned an unexpected shape'];
  const { tagName, isDraft, isPrerelease, assets } = release.data;
  const problems: string[] = [];
  if (tagName !== tag) problems.push(`release tag is ${tagName}, not ${tag}`);
  if (isPrerelease) problems.push('release is marked as a prerelease');
  if (isDraft !== expectDraft) problems.push(expectDraft ? 'release is no longer a draft' : 'release is still a draft');
  problems.push(...setDifference(allAssetNames(version), assets.map((asset) => asset.name)));
  for (const asset of assets) {
    const local = join(stage, asset.name);
    if (existsSync(local) && statSync(local).size !== asset.size) problems.push(`${asset.name} has a different size on GitHub`);
  }
  if (problems.length > 0) return problems;
  const downloaded = mkdtempSync(join(tmpdir(), 'interleaf-release-download-'));
  try {
    const download = gh(['release', 'download', tag, '--repo', RELEASE_REPO, '--dir', downloaded]);
    if (download.status !== 0) return [ghFailure(`gh release download ${tag}`, download)];
    const differing = allAssetNames(version).filter((name) => fileFacts(join(downloaded, name)).sha256 !== fileFacts(join(stage, name)).sha256);
    return [...differing.map((name) => `${name} downloaded from GitHub differs from the staged file`), ...verifyStage(downloaded, version, trust)];
  } finally {
    rmSync(downloaded, { recursive: true, force: true });
  }
}

export function releaseNotes(version: string): string {
  return [
    `Interleaf ${version}, stable channel.`,
    '',
    `macOS: ${PRODUCT_NAME}-${version}-arm64.dmg (Apple silicon) or ${PRODUCT_NAME}-${version}.dmg (Intel). Linux: the AppImage updates itself (${APPIMAGE_README_NAME} explains how to run it); the .deb and pacman packages update through a newer package from this page.`,
    '',
    'Interleaf installs an update only after verifying its Ed25519-signed manifest against a key built into the app. SHA256SUMS lists every file here, and SHA256SUMS.sig signs that list with the same key; see the installation guide for how to check a download by hand.',
  ].join('\n');
}

/** Creates the draft with every verified asset, then verifies the draft as GitHub stores it. */
export function stageRelease(stage: string, version: string, trust: UpdateTrust, notes: string, gh: GhRunner = runGh): string[] {
  const local = verifyStage(stage, version, trust);
  if (local.length > 0) return local;
  const tag = `v${version}`;
  if (gh(['release', 'view', tag, '--repo', RELEASE_REPO, '--json', 'tagName']).status === 0) {
    return [`${RELEASE_REPO} already has a release for ${tag}; inspect it instead of overwriting it.`];
  }
  const created = gh([
    'release', 'create', tag, '--repo', RELEASE_REPO, '--draft', '--title', `${PRODUCT_NAME} ${version}`, '--notes', notes,
    ...allAssetNames(version).map((name) => join(stage, name)),
  ]);
  if (created.status !== 0) return [ghFailure(`gh release create ${tag}`, created)];
  return remoteProblems(stage, version, trust, true, gh);
}

/** Publishes a verified draft as the latest stable release and checks the result as clients will see it. */
export function promoteRelease(stage: string, version: string, trust: UpdateTrust, gh: GhRunner = runGh): string[] {
  const draft = remoteProblems(stage, version, trust, true, gh);
  if (draft.length > 0) return draft;
  const tag = `v${version}`;
  const edited = gh(['release', 'edit', tag, '--repo', RELEASE_REPO, '--draft=false', '--prerelease=false', '--latest']);
  if (edited.status !== 0) return [ghFailure(`gh release edit ${tag}`, edited)];
  const published = remoteProblems(stage, version, trust, false, gh);
  const latest = gh(['api', `repos/${RELEASE_REPO}/releases/latest`, '--jq', '.tag_name']);
  return latest.status === 0 && latest.stdout.trim() === tag ? published : [...published, `GitHub does not report ${tag} as the latest release`];
}

/** The commands this tool accepts, each with the only flags it takes. */
const COMMANDS = {
  keygen: { required: [], optional: ['--dir'] },
  sign: { required: ['--key', '--stage'], optional: [] },
  verify: { required: ['--stage'], optional: [] },
  stage: { required: ['--stage'], optional: ['--notes-file'] },
  'verify-draft': { required: ['--stage'], optional: [] },
  promote: { required: ['--stage'], optional: [] },
} as const;

export type ReleaseCommand = keyof typeof COMMANDS;
export type ParsedCommand = { readonly command: ReleaseCommand; readonly flags: ReadonlyMap<string, string> };

const isCommand = (value: string): value is ReleaseCommand => Object.hasOwn(COMMANDS, value);

export function parseReleaseCommand(argv: readonly string[]): ParsedCommand {
  const [command = '', ...rest] = argv;
  if (!isCommand(command)) throw new Error(`Unknown command ${JSON.stringify(command)}; use one of ${Object.keys(COMMANDS).join(', ')}.`);
  const { required, optional } = COMMANDS[command];
  const allowed: readonly string[] = [...required, ...optional];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] ?? '';
    const value = rest[index + 1];
    if (!allowed.includes(flag) || flags.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`Unsupported or repeated argument ${JSON.stringify(flag)} for ${command}.`);
    }
    flags.set(flag, value);
  }
  const missing = required.filter((flag) => !flags.has(flag));
  if (missing.length > 0) throw new Error(`${command} needs ${missing.join(' and ')}.`);
  return { command, flags };
}

function report(problems: readonly string[], success: string): void {
  if (problems.length === 0) {
    console.log(success);
    return;
  }
  console.error('Refusing:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

function runCommand({ command, flags }: ParsedCommand, root: string): void {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const stage = resolve(flags.get('--stage') ?? '.');
  if (command === 'keygen') {
    const key = generateSigningKey(flags.get('--dir') ?? defaultKeyDirectory(), root);
    console.log(`Wrote the private key to ${key.privateKeyPath} (owner-only). Back it up offline; never commit or upload it.`);
    console.log('Pin this entry in UPDATE_TRUST.signingKeys (src/main/updates/update-trust.ts):');
    console.log(`  { keyId: '${key.keyId}', spkiBase64: '${key.spkiBase64}' },`);
  } else if (command === 'sign') {
    signRelease({ stage, version, key: loadSigningKey(flags.get('--key') ?? '', root, UPDATE_TRUST), trust: UPDATE_TRUST, releaseDate: new Date().toISOString() });
    report(verifyStage(stage, version, UPDATE_TRUST), `Signed and verified the ${version} stage directory ${stage}.`);
  } else if (command === 'verify') {
    report(verifyStage(stage, version, UPDATE_TRUST), `The ${version} stage directory is complete and verifies against the pinned keys.`);
  } else if (command === 'stage') {
    const notesFile = flags.get('--notes-file');
    const notes = notesFile === undefined ? releaseNotes(version) : readFileSync(notesFile, 'utf8');
    report(stageRelease(stage, version, UPDATE_TRUST, notes), `Draft v${version} in ${RELEASE_REPO} holds exactly the verified assets. Promote it when ready.`);
  } else if (command === 'verify-draft') {
    report(remoteProblems(stage, version, UPDATE_TRUST, true), `Draft v${version} matches the stage directory.`);
  } else {
    report(promoteRelease(stage, version, UPDATE_TRUST), `v${version} is the latest stable release in ${RELEASE_REPO}.`);
  }
}

/** A release must never be signed or published from a shell that builds update smoke packages. */
export function releaseEnvironmentProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  return env.INTERLEAF_UPDATE_SMOKE_TRUST === undefined ? [] : ['Unset INTERLEAF_UPDATE_SMOKE_TRUST; it belongs to the update smoke test, never a release.'];
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const environment = releaseEnvironmentProblems(process.env);
  if (environment.length > 0) {
    report(environment, '');
    return;
  }
  try {
    runCommand(parseReleaseCommand(process.argv.slice(2)), root);
  } catch (error) {
    report([error instanceof Error ? error.message : 'Unexpected failure.'], '');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
