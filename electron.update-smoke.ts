import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import type * as Envelope from './src/main/updates/update-envelope';
import type * as Release from './electron.update-release';
import type { UpdatePhase, UpdateState } from './src/shared/schemas/updates';
import type * as Trust from './src/main/updates/update-trust';
import type {} from './src/shared/types/api';

/**
 * Packaged two-version update smoke test: proves on a real build that version
 * A finds, verifies, downloads and installs version B from a signed manifest,
 * and that it refuses an empty destination, a manifest signed by an unpinned
 * key and an artifact whose bytes do not match the signed digest.
 *
 *   node electron.update-smoke.ts [--evidence <dir>]
 *
 * Linux builds an x64 AppImage; macOS builds a ZIP for this machine's arch,
 * signed with the Developer ID identity electron-builder discovers (Squirrel.Mac
 * installs only a bundle that satisfies the running app's designated
 * requirement) and never notarized. Both versions are throwaway smoke builds:
 *
 * - The signing key is an Ed25519 key generated in memory for this run and
 *   never written anywhere; the builds pin only it and a loopback origin, so
 *   they accept updates from nothing but this machine's loopback, signed by a
 *   key that is gone when the run ends (see src/main/updates/smoke-trust.ts).
 * - `out/` is always rebuilt without the smoke anchor afterwards, so a later
 *   package step cannot ship a smoke build, and both release tools refuse to
 *   run while `INTERLEAF_UPDATE_SMOKE_TRUST` is set.
 * - Every app launch uses a temporary profile, home and temp directory and an
 *   OS-only PATH (no provider CLI is discoverable, so no paid call is
 *   possible). Packages live in a temporary sandbox; nothing under
 *   /Applications or the user's own profile is touched.
 * - The feed server records every request and the run fails if any carries
 *   credentials.
 */

const envelopeModule = './src/main/updates/update-envelope.ts';
const trustModule = './src/main/updates/update-trust.ts';
const releaseModule = './electron.update-release.ts';
const { signingKeyId } = (await import(envelopeModule)) as typeof Envelope;
const { UPDATE_TRUST, latestManifestUrl, taggedAssetUrl } = (await import(trustModule)) as typeof Trust;
const { appImageBlockMapSize, fileFacts, manifestPayload, releaseAssets, signManifest } = (await import(releaseModule)) as typeof Release;

export const SMOKE_PORT = 47613;
export const SMOKE_VERSIONS = { from: '1.0.0', to: '1.0.1' } as const;
const SMOKE_ENV = 'INTERLEAF_UPDATE_SMOKE_TRUST';
const OS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BUILD_DEADLINE_MS = 30 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 90_000;
const PHASE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
const LINUX_PASSTHROUGH = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const;

type UpdateTrust = Trust.UpdateTrust;
type Environment = Readonly<Record<string, string | undefined>>;
export type SmokePlatform = { readonly platform: 'darwin' | 'linux'; readonly arch: 'arm64' | 'x64' };
type SmokeKey = { readonly keyId: string; readonly spkiBase64: string; readonly privateKey: KeyObject };

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The platforms this harness can package and update on. */
export function smokePlatform(platform: NodeJS.Platform, arch: string): SmokePlatform | string {
  if (platform === 'linux') return arch === 'x64' ? { platform, arch } : 'Linux updates ship only an x64 AppImage.';
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return { platform, arch };
  return `No self-updating package exists for ${platform}/${arch}.`;
}

export function ephemeralSmokeKey(): SmokeKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { keyId: signingKeyId(spki), spkiBase64: spki.toString('base64'), privateKey };
}

/** The value electron.vite.config.ts inlines into the smoke build's main bundle. */
export function smokeAnchor(key: Pick<SmokeKey, 'keyId' | 'spkiBase64'>, port = SMOKE_PORT): string {
  const { origin, signingKeys } = smokeTrust(key, port);
  return JSON.stringify({ origin, signingKeys });
}

export function smokeTrust(key: Pick<SmokeKey, 'keyId' | 'spkiBase64'>, port = SMOKE_PORT): UpdateTrust {
  return { ...UPDATE_TRUST, origin: `http://127.0.0.1:${String(port)}`, signingKeys: [{ keyId: key.keyId, spkiBase64: key.spkiBase64 }] };
}

/** electron-builder arguments for one throwaway smoke package: never published, never notarized. */
export function builderArgs(target: SmokePlatform, version: string, output: string): string[] {
  const common = ['--publish', 'never', `-c.extraMetadata.version=${version}`, `-c.directories.output=${output}`];
  if (target.platform === 'linux') return ['--linux', 'AppImage', '--x64', ...common];
  return ['--mac', 'zip', `--${target.arch}`, '-c.mac.notarize=false', ...common];
}

/** The complete environment for a launched app: a temporary profile and nothing else from the host but the display. */
export function appEnvironment(sandbox: string, platform: SmokePlatform['platform'], host: Environment): Record<string, string> {
  const env: Record<string, string> = {
    PATH: OS_PATH,
    HOME: join(sandbox, 'home'),
    TMPDIR: join(sandbox, 'tmp'),
    INTERLEAF_USER_DATA: join(sandbox, 'user-data'),
  };
  if (platform === 'linux') {
    for (const name of LINUX_PASSTHROUGH) {
      const value = host[name];
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
}

export type ByteRange = readonly [start: number, end: number];

/** A `Range` header resolved against a file size: whole file, the satisfiable ranges, or unsatisfiable. */
export function parseRanges(header: string | undefined, size: number): 'full' | 'invalid' | ByteRange[] {
  if (header === undefined) return 'full';
  const match = /^bytes=(.+)$/.exec(header.trim());
  if (match?.[1] === undefined) return 'invalid';
  const ranges: ByteRange[] = [];
  for (const part of match[1].split(',')) {
    const range = parseRange(part.trim(), size);
    if (range === undefined) return 'invalid';
    ranges.push(range);
  }
  return ranges.length === 0 ? 'invalid' : ranges;
}

function parseRange(part: string, size: number): ByteRange | undefined {
  const match = /^(\d*)-(\d*)$/.exec(part);
  if (match === null || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix === 0 ? undefined : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start > end || start >= size ? undefined : [start, end];
}

export type FeedRequest = { readonly method: string; readonly path: string; readonly status: number; readonly ranged: boolean; readonly credentials: boolean };

/** A loopback stand-in for the release destination: exact paths only, whose files the run swaps per scenario. */
export class SmokeFeed {
  readonly requests: FeedRequest[] = [];
  private routes = new Map<string, string>();
  private readonly trust: UpdateTrust;

  constructor(trust: UpdateTrust) {
    this.trust = trust;
  }

  manifestPath(platform: SmokePlatform['platform']): string {
    return latestManifestUrl(this.trust, platform).pathname;
  }

  assetPath(version: string, name: string): string {
    return taggedAssetUrl(this.trust, `v${version}`, name).pathname;
  }

  /** Replaces every route at once: request path to the file served there. */
  serve(routes: ReadonlyMap<string, string>): void {
    this.routes = new Map(routes);
  }

  fileFor(method: string | undefined, url: string | undefined): string | undefined {
    if (method !== 'GET' && method !== 'HEAD') return undefined;
    const path = new URL(url ?? '/', 'http://127.0.0.1').pathname;
    return this.routes.get(path);
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const file = this.fileFor(request.method, request.url);
    const status = file === undefined ? 404 : sendFile(file, request, response);
    if (file === undefined) response.writeHead(404).end();
    this.requests.push({
      method: request.method ?? '',
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      status,
      ranged: request.headers.range !== undefined,
      credentials: request.headers.authorization !== undefined || request.headers.cookie !== undefined,
    });
  }
}

function sendFile(file: string, request: IncomingMessage, response: ServerResponse): number {
  const { size } = statSync(file);
  const ranges = parseRanges(request.headers.range, size);
  if (ranges === 'invalid') {
    response.writeHead(416, { 'content-range': `bytes */${String(size)}` }).end();
    return 416;
  }
  if (ranges === 'full') {
    response.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
    pipeRanges(file, [[0, size - 1]], response, request.method === 'HEAD', undefined);
    return 200;
  }
  if (ranges.length === 1 && ranges[0] !== undefined) {
    const [start, end] = ranges[0];
    response.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`, 'content-type': 'application/octet-stream' });
    pipeRanges(file, ranges, response, request.method === 'HEAD', undefined);
    return 206;
  }
  const boundary = `interleafsmoke${String(Date.now())}`;
  response.writeHead(206, { 'content-type': `multipart/byteranges; boundary=${boundary}` });
  pipeRanges(file, ranges, response, request.method === 'HEAD', { boundary, size });
  return 206;
}

/** Streams ranges in order, each framed as a multipart part when `multipart` is given. */
function pipeRanges(file: string, ranges: readonly ByteRange[], response: ServerResponse, headOnly: boolean, multipart: { boundary: string; size: number } | undefined): void {
  if (headOnly) {
    response.end();
    return;
  }
  const next = (index: number): void => {
    const range = ranges[index];
    if (range === undefined) {
      response.end(multipart === undefined ? undefined : `\r\n--${multipart.boundary}--\r\n`);
      return;
    }
    if (multipart !== undefined) {
      response.write(`\r\n--${multipart.boundary}\r\ncontent-type: application/octet-stream\r\ncontent-range: bytes ${String(range[0])}-${String(range[1])}/${String(multipart.size)}\r\n\r\n`);
    }
    const stream = createReadStream(file, { start: range[0], end: range[1] });
    stream.on('error', () => response.destroy());
    stream.on('end', () => { next(index + 1); });
    stream.pipe(response, { end: false });
  };
  next(0);
}

function listen(feed: SmokeFeed): Promise<Server> {
  const server = createServer((request, response) => { feed.handle(request, response); });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(SMOKE_PORT, '127.0.0.1', () => { done(server); });
  });
}

function run(command: string, args: readonly string[], cwd: string, env: Environment): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false, timeout: BUILD_DEADLINE_MS });
  if (result.status !== 0) throw new Error(`${basename(command)} ${args.join(' ')} failed (${String(result.status ?? result.signal)}).`);
}

/** `process.env` without the smoke anchor, so nothing after the smoke build can inherit it. */
export function withoutSmokeAnchor(env: Environment): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== SMOKE_ENV));
}

type Builds = { readonly from: string; readonly to: string };

function buildSmokePackages(root: string, sandbox: string, target: SmokePlatform, anchor: string): Builds {
  const bin = (name: string): string => join(root, 'node_modules', '.bin', name);
  const env = withoutSmokeAnchor(process.env);
  try {
    run(bin('electron-vite'), ['build'], root, { ...env, [SMOKE_ENV]: anchor });
    const outputs = { from: join(sandbox, `build-${SMOKE_VERSIONS.from}`), to: join(sandbox, `build-${SMOKE_VERSIONS.to}`) };
    run(bin('electron-builder'), builderArgs(target, SMOKE_VERSIONS.from, outputs.from), root, env);
    run(bin('electron-builder'), builderArgs(target, SMOKE_VERSIONS.to, outputs.to), root, env);
    return outputs;
  } finally {
    run(bin('electron-vite'), ['build'], root, env);
  }
}

type Installed = { readonly launchPath: string; readonly bundle: string };

/** Copies version A out of its build directory into the sandbox, where it may replace itself. */
function installFrom(builds: Builds, sandbox: string, target: SmokePlatform): Installed {
  const directory = join(sandbox, 'install');
  mkdirSync(directory, { recursive: true });
  if (target.platform === 'linux') {
    const appImage = join(directory, releaseAssets(SMOKE_VERSIONS.from).appImage);
    copyFileSync(join(builds.from, basename(appImage)), appImage);
    chmodSync(appImage, 0o755);
    return { launchPath: appImage, bundle: appImage };
  }
  const bundle = join(directory, 'Interleaf.app');
  run('/usr/bin/ditto', [join(builds.from, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Interleaf.app'), bundle], sandbox, { PATH: OS_PATH });
  return { launchPath: join(bundle, 'Contents', 'MacOS', 'Interleaf'), bundle };
}

type UpdateArtifact = { readonly name: string; readonly path: string; readonly substitute: string; readonly blockmaps: readonly string[] };

/** Version B's update file, version A's same-named file to substitute for it, and the blockmaps served beside them. */
function updateArtifact(builds: Builds, target: SmokePlatform): UpdateArtifact {
  const [from, to] = [releaseAssets(SMOKE_VERSIONS.from), releaseAssets(SMOKE_VERSIONS.to)];
  if (target.platform === 'linux') {
    return { name: to.appImage, path: join(builds.to, to.appImage), substitute: join(builds.from, from.appImage), blockmaps: [] };
  }
  const zipName = (assets: Release.ReleaseAssets): string => assets.macZips.find((entry) => entry.arch === target.arch)?.name ?? '';
  const path = join(builds.to, zipName(to));
  const substitute = join(builds.from, zipName(from));
  return { name: zipName(to), path, substitute, blockmaps: [`${substitute}.blockmap`, `${path}.blockmap`].filter((file) => existsSync(file)) };
}

function writeManifest(path: string, target: SmokePlatform, artifact: UpdateArtifact, trust: UpdateTrust, key: SmokeKey): void {
  const facts = fileFacts(artifact.path);
  const kind = target.platform === 'linux' ? 'AppImage' : 'zip';
  const file = { name: artifact.name, arch: target.arch, kind, size: facts.size, sha512: facts.sha512 } as const;
  const files = kind === 'AppImage' ? [{ ...file, blockMapSize: appImageBlockMapSize(artifact.path) }] : [file];
  const payload = manifestPayload({ trust, platform: target.platform, version: SMOKE_VERSIONS.to, releaseDate: new Date().toISOString(), files });
  writeFileSync(path, signManifest(payload, { keyId: key.keyId, privateKey: key.privateKey }));
}

/**
 * Chromium switches that keep the smoke app out of the host's secret store.
 * A smoke build carries the real app's name, bundle id and (on macOS) signer,
 * so its `safeStorage` would otherwise ask the login keychain for the
 * installed app's "Interleaf Safe Storage" item and block main on a system
 * prompt; on Linux it would open the desktop keyring.
 */
export function launchArgs(platform: SmokePlatform['platform']): string[] {
  return platform === 'darwin' ? ['--use-mock-keychain'] : ['--password-store=basic'];
}

/** Closes the app, and kills it when it does not exit in time (for example when main is blocked). */
async function closeApp(app: ElectronApplication): Promise<void> {
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(CLOSE_TIMEOUT_MS).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
}

async function launch(executablePath: string, env: Record<string, string>, platform: SmokePlatform['platform']): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath, cwd: '/', env, args: launchArgs(platform), timeout: LAUNCH_TIMEOUT_MS });
  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForLoadState('domcontentloaded', { timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForFunction(() => 'interleafAPI' in globalThis, undefined, { timeout: LAUNCH_TIMEOUT_MS });
  const opens = await page.evaluate(async () => (await globalThis.interleafAPI.onboarding.getLaunchState()).shouldAutoOpen);
  if (opens) {
    await page.getByTestId('onboarding-wizard').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('onboarding-finish-later').click();
    await page.getByTestId('onboarding-wizard').waitFor({ state: 'hidden', timeout: 10_000 });
  }
  return { app, page };
}

async function updateState(page: Page): Promise<UpdateState> {
  return page.evaluate(() => globalThis.interleafAPI.updates.getState());
}

/** Polls main's update state until `settled` holds, failing with the last phase seen. */
async function waitForPhase(page: Page, settled: (phase: UpdatePhase) => boolean, label: string): Promise<UpdatePhase> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  let last: UpdatePhase | undefined;
  while (Date.now() < deadline) {
    last = (await updateState(page)).phase;
    if (settled(last)) return last;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: still ${JSON.stringify(last)} after ${String(PHASE_TIMEOUT_MS / 1000)} s.`);
}

const settledCheck = (phase: UpdatePhase): boolean => phase.status !== 'checking' && phase.status !== 'idle';
const settledDownload = (phase: UpdatePhase): boolean => phase.status !== 'downloading';

async function openAboutUpdates(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-rail-about').click();
  await page.getByTestId('updates-status').waitFor({ state: 'visible', timeout: 10_000 });
}

export type ScenarioResult = { readonly name: string; readonly expected: string; readonly observed: string };

type SmokeContext = {
  readonly target: SmokePlatform;
  readonly feed: SmokeFeed;
  readonly trust: UpdateTrust;
  readonly key: SmokeKey;
  readonly artifact: UpdateArtifact;
  readonly builds: Builds;
  readonly sandbox: string;
  readonly evidence: string;
};

function observed(phase: UpdatePhase): string {
  return phase.status === 'error' ? `error:${phase.code}` : phase.status;
}

async function checkThroughPanel(page: Page): Promise<UpdatePhase> {
  await page.getByTestId('updates-check').click();
  return waitForPhase(page, settledCheck, 'check');
}

async function downloadThroughPanel(page: Page): Promise<UpdatePhase> {
  await page.getByTestId('updates-download').click();
  return waitForPhase(page, settledDownload, 'download');
}

/** Empty destination, unpinned signer, tampered bytes, then the genuine update, all through the About & Updates panel. */
async function runScenarios(page: Page, context: SmokeContext): Promise<ScenarioResult[]> {
  const { feed, target, artifact } = context;
  const manifests = join(context.sandbox, 'manifests');
  mkdirSync(manifests, { recursive: true });
  const results: ScenarioResult[] = [];

  feed.serve(new Map());
  results.push({ name: 'empty destination', expected: 'no-release', observed: observed(await checkThroughPanel(page)) });
  await page.screenshot({ path: join(context.evidence, '1-no-release.png') });

  const stranger = ephemeralSmokeKey();
  writeManifest(join(manifests, 'foreign.json'), target, artifact, smokeTrust(stranger), stranger);
  feed.serve(new Map([[feed.manifestPath(target.platform), join(manifests, 'foreign.json')]]));
  results.push({ name: 'manifest signed by an unpinned key', expected: 'error:verification-failed', observed: observed(await checkThroughPanel(page)) });

  writeManifest(join(manifests, 'genuine.json'), target, artifact, context.trust, context.key);
  feed.serve(new Map([[feed.manifestPath(target.platform), join(manifests, 'genuine.json')], [feed.assetPath(SMOKE_VERSIONS.to, artifact.name), artifact.substitute]]));
  results.push({ name: 'signed manifest, substituted artifact: check', expected: 'available', observed: observed(await checkThroughPanel(page)) });
  results.push({ name: 'signed manifest, substituted artifact: download', expected: 'error:verification-failed', observed: observed(await downloadThroughPanel(page)) });
  await page.screenshot({ path: join(context.evidence, '2-integrity-failure.png') });

  const genuine = new Map([[feed.manifestPath(target.platform), join(manifests, 'genuine.json')], [feed.assetPath(SMOKE_VERSIONS.to, artifact.name), artifact.path]]);
  for (const blockmap of artifact.blockmaps) {
    const version = blockmap.startsWith(context.builds.from) ? SMOKE_VERSIONS.from : SMOKE_VERSIONS.to;
    genuine.set(feed.assetPath(version, basename(blockmap)), blockmap);
  }
  feed.serve(genuine);
  results.push({ name: 'genuine update: check', expected: 'available', observed: observed(await checkThroughPanel(page)) });
  results.push({ name: 'genuine update: download', expected: 'downloaded', observed: observed(await downloadThroughPanel(page)) });
  await page.screenshot({ path: join(context.evidence, '3-downloaded.png') });
  return results;
}

/** Clicks Restart; the app replies before it drains, or closes first. Either way it must then exit. */
async function restartThroughPanel(app: ElectronApplication, page: Page): Promise<string> {
  const exited = new Promise<void>((done) => app.process().once('exit', () => { done(); }));
  const reply = page.evaluate(() => globalThis.interleafAPI.updates.restart()).then(
    (result) => result.outcome,
    () => 'closed-before-reply',
  );
  const outcome = await reply;
  const timedOut = await Promise.race([exited.then(() => false), sleep(INSTALL_TIMEOUT_MS).then(() => true)]);
  if (timedOut) app.process().kill('SIGKILL');
  return timedOut ? `${outcome}, did not exit` : outcome;
}

function bundleVersion(bundle: string): string | undefined {
  const plist = join(bundle, 'Contents', 'Info.plist');
  const result = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8', shell: false, timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Squirrel.Mac's ShipIt swaps the bundle after the app exits; the smoke build does not relaunch it. */
async function awaitMacInstall(bundle: string): Promise<string[]> {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline && bundleVersion(bundle) !== SMOKE_VERSIONS.to) await sleep(1000);
  const version = bundleVersion(bundle);
  if (version !== SMOKE_VERSIONS.to) return [`${bundle} still reports ${String(version)} after ${String(INSTALL_TIMEOUT_MS / 1000)} s`];
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8', shell: false, timeout: 60_000 });
  return verify.status === 0 ? [] : [`the installed bundle fails codesign --verify: ${verify.stderr.trim()}`];
}

/** Processes started with this run's isolated profile, found through their environment. */
function profileProcesses(userData: string): { pid: number; appImage: string | undefined }[] {
  const marker = `INTERLEAF_USER_DATA=${userData}`;
  const found: { pid: number; appImage: string | undefined }[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const variables = readFileSync(join('/proc', entry, 'environ'), 'latin1').split('\0');
      if (!variables.includes(marker)) continue;
      found.push({ pid, appImage: variables.find((value) => value.startsWith('APPIMAGE='))?.slice('APPIMAGE='.length) });
    } catch {
      // The process exited or belongs to another user.
    }
  }
  return found;
}

async function stopProcesses(userData: string): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const { pid } of profileProcesses(userData)) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    await sleep(signal === 'SIGTERM' ? 5000 : 500);
  }
}

/** The AppImage installer moves B beside A under B's name and starts it with this run's environment. */
async function awaitAppImageInstall(installed: Installed, artifact: { path: string }, userData: string): Promise<{ problems: string[]; launchPath: string }> {
  const launchPath = join(resolve(installed.bundle, '..'), releaseAssets(SMOKE_VERSIONS.to).appImage);
  const problems: string[] = [];
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  let relaunched: { pid: number; appImage: string | undefined } | undefined;
  while (Date.now() < deadline && relaunched === undefined) {
    relaunched = profileProcesses(userData).find((entry) => entry.appImage === launchPath);
    if (relaunched === undefined) await sleep(500);
  }
  if (relaunched === undefined) problems.push(`no process relaunched from ${launchPath}`);
  await stopProcesses(userData);
  if (existsSync(installed.bundle)) problems.push(`${installed.bundle} was not replaced`);
  if (!existsSync(launchPath)) problems.push(`${launchPath} does not exist`);
  else if (fileFacts(launchPath).sha512 !== fileFacts(artifact.path).sha512) problems.push(`${launchPath} is not the verified ${SMOKE_VERSIONS.to} AppImage`);
  return { problems, launchPath };
}

/** Relaunches the installed copy with the same profile and reads what it reports about itself. */
async function verifyRelaunch(launchPath: string, env: Record<string, string>, context: SmokeContext): Promise<string[]> {
  const { app, page } = await launch(launchPath, env, context.target.platform);
  try {
    const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    const settings = await page.evaluate(() => globalThis.interleafAPI.settings.get());
    await openAboutUpdates(page);
    await page.screenshot({ path: join(context.evidence, '4-updated.png') });
    const problems: string[] = [];
    if (version !== SMOKE_VERSIONS.to) problems.push(`the relaunched app reports ${version}, not ${SMOKE_VERSIONS.to}`);
    if (settings.updates.automaticChecks) problems.push('the automatic-check opt-out did not survive the update');
    return problems;
  } finally {
    await closeApp(app);
  }
}

export function scenarioProblems(results: readonly ScenarioResult[]): string[] {
  return results.filter((result) => result.observed !== result.expected).map((result) => `${result.name}: expected ${result.expected}, observed ${result.observed}`);
}

export function requestProblems(requests: readonly FeedRequest[]): string[] {
  const problems = requests.filter((request) => request.credentials).map((request) => `${request.method} ${request.path} carried credentials`);
  if (!requests.some((request) => request.ranged || request.status === 200)) problems.push('the update was never downloaded from the feed');
  return problems;
}

async function updateAndInstall(installed: Installed, env: Record<string, string>, context: SmokeContext): Promise<{ results: ScenarioResult[]; problems: string[] }> {
  const { app, page } = await launch(installed.launchPath, env, context.target.platform);
  let results: ScenarioResult[] = [];
  try {
    await openAboutUpdates(page);
    const toggle = page.getByTestId('settings-updates-automatic-checks');
    if (await toggle.isChecked()) await toggle.click();
    results = await runScenarios(page, context);
  } catch (error) {
    await closeApp(app);
    throw error;
  }
  const scenarioFailures = scenarioProblems(results);
  if (scenarioFailures.length > 0) {
    await closeApp(app);
    return { results, problems: scenarioFailures };
  }
  const outcome = await restartThroughPanel(app, page);
  results.push({ name: 'restart to update', expected: 'restarting', observed: outcome });
  const installed2 = context.target.platform === 'darwin'
    ? { problems: await awaitMacInstall(installed.bundle), launchPath: installed.launchPath }
    : await awaitAppImageInstall(installed, context.artifact, env.INTERLEAF_USER_DATA ?? '');
  const problems = [...scenarioProblems(results), ...installed2.problems];
  if (problems.length === 0) problems.push(...(await verifyRelaunch(installed2.launchPath, env, context)));
  return { results, problems };
}

function parseEvidence(argv: readonly string[], root: string): string {
  if (argv.length === 0) return join(root, 'release', 'update-smoke');
  if (argv.length === 2 && argv[0] === '--evidence' && argv[1] !== undefined) return resolve(argv[1]);
  throw new Error('Usage: node electron.update-smoke.ts [--evidence <dir>]');
}

async function smoke(root: string, target: SmokePlatform, evidence: string): Promise<string[]> {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-update-smoke-')));
  const key = ephemeralSmokeKey();
  const trust = smokeTrust(key);
  const feed = new SmokeFeed(trust);
  const env = appEnvironment(sandbox, target.platform, process.env);
  for (const directory of [env.HOME, env.TMPDIR]) if (directory !== undefined) mkdirSync(directory, { recursive: true });
  let server: Server | undefined;
  let outcome: { results: ScenarioResult[]; problems: string[] } = { results: [], problems: [] };
  try {
    const builds = buildSmokePackages(root, sandbox, target, smokeAnchor(key));
    const installed = installFrom(builds, sandbox, target);
    if (isInside('/Applications', realpathSync(installed.bundle))) throw new Error('Refusing to update a copy under /Applications.');
    server = await listen(feed);
    const context: SmokeContext = { target, feed, trust, key, artifact: updateArtifact(builds, target), builds, sandbox, evidence };
    outcome = await updateAndInstall(installed, env, context);
    outcome.problems.push(...requestProblems(feed.requests));
  } catch (error) {
    outcome.problems.push(error instanceof Error ? error.message : 'Unexpected failure.');
  } finally {
    server?.close();
    if (target.platform === 'linux') await stopProcesses(env.INTERLEAF_USER_DATA ?? '');
    rmSync(sandbox, { recursive: true, force: true });
  }
  const report = { ...target, versions: SMOKE_VERSIONS, scenarios: outcome.results, requests: feed.requests, problems: outcome.problems };
  writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return outcome.problems;
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const target = smokePlatform(process.platform, process.arch);
  if (typeof target === 'string') throw new Error(target);
  if (process.env[SMOKE_ENV] !== undefined) throw new Error(`Unset ${SMOKE_ENV}; this run sets it only for its own build.`);
  const evidence = parseEvidence(process.argv.slice(2), root);
  mkdirSync(evidence, { recursive: true });
  const problems = await smoke(root, target, evidence);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Update smoke passed: ${SMOKE_VERSIONS.from} installed ${SMOKE_VERSIONS.to} on ${target.platform}/${target.arch}. Evidence: ${evidence}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unexpected failure.');
    process.exitCode = 1;
  }
}
