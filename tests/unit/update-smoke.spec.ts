import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUpdateTrust, isSmokeBuild, trustFromSmokeAnchor } from '@main/updates/smoke-trust';
import { UPDATE_TRUST } from '@main/updates/update-trust';
import {
  SMOKE_PORT,
  SmokeFeed,
  appEnvironment,
  builderArgs,
  ephemeralSmokeKey,
  launchArgs,
  parseRanges,
  requestProblems,
  scenarioProblems,
  smokeAnchor,
  smokePlatform,
  smokeTrust,
  withoutSmokeAnchor,
} from '../../electron.update-smoke';

/**
 * The packaged update smoke test builds throwaway versions that trust only a
 * loopback feed and an in-memory key. These cover what keeps that safe (the
 * anchor a build may inline, the isolated launch environment, the build
 * arguments) and the loopback feed's routing and range handling; the packaged
 * run itself is `node electron.update-smoke.ts`.
 */

describe('smoke trust anchor', () => {
  const key = ephemeralSmokeKey();

  it('is the production trust in every ordinary build', () => {
    expect(isSmokeBuild()).toBe(false);
    expect(buildUpdateTrust()).toBe(UPDATE_TRUST);
    expect(trustFromSmokeAnchor(null)).toBe(UPDATE_TRUST);
  });

  it('pins only the loopback origin and the one ephemeral key the smoke run inlined', () => {
    const trust = trustFromSmokeAnchor(smokeAnchor(key));
    expect(trust).toEqual(smokeTrust(key));
    expect(trust).toMatchObject({ product: UPDATE_TRUST.product, repositoryPath: UPDATE_TRUST.repositoryPath, origin: `http://127.0.0.1:${String(SMOKE_PORT)}` });
  });

  it('pins no key, and so fails closed, for any anchor that is not exactly that', () => {
    const entry = { keyId: key.keyId, spkiBase64: key.spkiBase64 };
    const anchors = [
      'not json',
      JSON.stringify({ origin: 'https://github.com', signingKeys: [entry] }),
      JSON.stringify({ origin: 'http://127.0.0.1.evil.example:4000', signingKeys: [entry] }),
      JSON.stringify({ origin: 'http://localhost:47613', signingKeys: [entry] }),
      JSON.stringify({ origin: 'http://127.0.0.1:47613', signingKeys: [] }),
      JSON.stringify({ origin: 'http://127.0.0.1:47613', signingKeys: [entry, entry] }),
      JSON.stringify({ origin: 'http://127.0.0.1:47613', signingKeys: [entry], repositoryPath: '/someone/else' }),
    ];
    for (const anchor of anchors) {
      expect(trustFromSmokeAnchor(anchor)).toEqual({ ...UPDATE_TRUST, signingKeys: [] });
    }
  });
});

describe('smoke build and launch inputs', () => {
  it('supports only the self-updating packages', () => {
    expect(smokePlatform('linux', 'x64')).toEqual({ platform: 'linux', arch: 'x64' });
    expect(smokePlatform('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(typeof smokePlatform('linux', 'arm64')).toBe('string');
    expect(typeof smokePlatform('win32', 'x64')).toBe('string');
  });

  it('never publishes or notarizes a smoke package', () => {
    const linux = builderArgs({ platform: 'linux', arch: 'x64' }, '1.0.0', '/sandbox/build');
    expect(linux).toEqual(['--linux', 'AppImage', '--x64', '--publish', 'never', '-c.extraMetadata.version=1.0.0', '-c.directories.output=/sandbox/build']);
    const mac = builderArgs({ platform: 'darwin', arch: 'arm64' }, '1.0.1', '/sandbox/build');
    expect(mac).toEqual(expect.arrayContaining(['--mac', 'zip', '--arm64', '-c.mac.notarize=false', '--publish', 'never']));
  });

  it('launches the app with an isolated profile and none of the host environment but the display', () => {
    const host = { PATH: '/opt/agents/bin:/usr/bin', HOME: '/home/someone', ANTHROPIC_API_KEY: 'secret', DISPLAY: ':99', XAUTHORITY: '/tmp/x' };
    expect(appEnvironment('/sandbox', 'linux', host)).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/sandbox/home',
      TMPDIR: '/sandbox/tmp',
      INTERLEAF_USER_DATA: '/sandbox/user-data',
      DISPLAY: ':99',
      XAUTHORITY: '/tmp/x',
    });
    expect(appEnvironment('/sandbox', 'darwin', host)).not.toHaveProperty('DISPLAY');
  });

  it('keeps the smoke app away from the host keychain or keyring', () => {
    expect(launchArgs('darwin')).toEqual(['--use-mock-keychain']);
    expect(launchArgs('linux')).toEqual(['--password-store=basic']);
  });

  it('keeps the smoke anchor out of every step after the smoke build', () => {
    expect(withoutSmokeAnchor({ PATH: '/usr/bin', INTERLEAF_UPDATE_SMOKE_TRUST: '{}' })).toEqual({ PATH: '/usr/bin' });
  });
});

describe('parseRanges', () => {
  it('resolves single, open, suffix and multiple ranges against the file size', () => {
    expect(parseRanges(undefined, 100)).toBe('full');
    expect(parseRanges('bytes=0-9', 100)).toEqual([[0, 9]]);
    expect(parseRanges('bytes=90-', 100)).toEqual([[90, 99]]);
    expect(parseRanges('bytes=-10', 100)).toEqual([[90, 99]]);
    expect(parseRanges('bytes=95-200', 100)).toEqual([[95, 99]]);
    expect(parseRanges('bytes=0-1, 10-11', 100)).toEqual([[0, 1], [10, 11]]);
  });

  it('rejects malformed or unsatisfiable ranges', () => {
    for (const header of ['items=0-1', 'bytes=', 'bytes=-', 'bytes=5-1', 'bytes=100-', 'bytes=-0', 'bytes=a-b']) {
      expect(parseRanges(header, 100)).toBe('invalid');
    }
  });
});

describe('SmokeFeed', () => {
  let server: Server | undefined;
  let directory: string | undefined;

  afterEach(() => {
    server?.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  async function serveFeed(): Promise<{ feed: SmokeFeed; base: string; file: string }> {
    directory = mkdtempSync(join(tmpdir(), 'interleaf-smoke-feed-'));
    const file = join(directory, 'artifact.bin');
    writeFileSync(file, '0123456789abcdefghij');
    const feed = new SmokeFeed(smokeTrust(ephemeralSmokeKey()));
    const listening = createServer((request, response) => { feed.handle(request, response); });
    server = listening;
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
    return { feed, base: `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`, file };
  }

  it('serves only the exact release paths, as the release destination would', async () => {
    const { feed, base, file } = await serveFeed();
    expect(feed.manifestPath('linux')).toBe('/FrescoFlacko/interleaf-releases/releases/latest/download/interleaf-stable-linux-x64.json');
    expect(feed.assetPath('1.0.1', 'Interleaf-1.0.1.AppImage')).toBe('/FrescoFlacko/interleaf-releases/releases/download/v1.0.1/Interleaf-1.0.1.AppImage');
    feed.serve(new Map([[feed.assetPath('1.0.1', 'a.bin'), file]]));
    const found = await fetch(`${base}${feed.assetPath('1.0.1', 'a.bin')}`);
    expect(await found.text()).toBe('0123456789abcdefghij');
    expect((await fetch(`${base}${feed.manifestPath('darwin')}`)).status).toBe(404);
    expect((await fetch(`${base}${feed.assetPath('1.0.1', 'a.bin')}`, { method: 'POST' })).status).toBe(404);
    feed.serve(new Map());
    expect((await fetch(`${base}${feed.assetPath('1.0.1', 'a.bin')}`)).status).toBe(404);
  });

  it('answers single and multiple byte ranges the way the differential downloader reads them', async () => {
    const { feed, base, file } = await serveFeed();
    const path = feed.assetPath('1.0.1', 'a.bin');
    feed.serve(new Map([[path, file]]));
    const single = await fetch(`${base}${path}`, { headers: { range: 'bytes=2-4' } });
    expect(single.status).toBe(206);
    expect(single.headers.get('content-range')).toBe('bytes 2-4/20');
    expect(await single.text()).toBe('234');
    const multiple = await fetch(`${base}${path}`, { headers: { range: 'bytes=0-1,18-19' } });
    const boundary = /boundary=(\S+)/.exec(multiple.headers.get('content-type') ?? '')?.[1] ?? '';
    const body = await multiple.text();
    expect(multiple.status).toBe(206);
    expect(body).toContain(`--${boundary}\r\ncontent-type: application/octet-stream\r\ncontent-range: bytes 0-1/20\r\n\r\n01\r\n`);
    expect(body).toContain('content-range: bytes 18-19/20\r\n\r\nij');
    expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect((await fetch(`${base}${path}`, { headers: { range: 'bytes=40-50' } })).status).toBe(416);
  });

  it('records every request and flags any that carries credentials', async () => {
    const { feed, base, file } = await serveFeed();
    const path = feed.assetPath('1.0.1', 'a.bin');
    feed.serve(new Map([[path, file]]));
    await fetch(`${base}${path}`);
    await fetch(`${base}${path}`, { headers: { authorization: 'Bearer x' } });
    expect(feed.requests.map((request) => request.credentials)).toEqual([false, true]);
    expect(requestProblems(feed.requests)).toEqual([`GET ${path} carried credentials`]);
    expect(requestProblems([])).toEqual(['the update was never downloaded from the feed']);
  });
});

describe('smoke verdicts', () => {
  it('fails on any scenario whose observed phase differs from the expected one', () => {
    expect(scenarioProblems([{ name: 'empty', expected: 'no-release', observed: 'no-release' }])).toEqual([]);
    expect(scenarioProblems([{ name: 'empty', expected: 'no-release', observed: 'up-to-date' }])).toEqual(['empty: expected no-release, observed up-to-date']);
  });
});
