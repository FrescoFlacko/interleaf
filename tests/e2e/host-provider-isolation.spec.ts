import { expect, test } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureOpenRouterTestSeam, launchInterleaf, type AppHandle } from './helpers';
import { refusedMainRequests } from './main-network-guard';
import { offlinePath } from './offline-environment';

/**
 * The real app process cannot find a provider CLI outside the fixture `PATH`
 * it was launched with, and main cannot send an unhandled request off the
 * machine.
 *
 * Every provider binary name the app looks up is planted, as a marker-writing
 * script, in the per-user directories macOS discovery appends behind the
 * inherited `PATH` (`~/.local/bin`, `~/.bun/bin`) of this launch's own `HOME`.
 * Without the isolation switch those directories would be searched; with it,
 * none of the scripts may be detected and none may run at all.
 */
const PROVIDER_BINARIES = ['codex', 'claude', 'agy', 'copilot', 'opencode', 'pi', 'cursor-agent', 'omp', 'gemini'];

test.describe('E2E host-provider isolation', () => {
  let app: AppHandle;
  let root: string;
  let home: string;
  let markers: string;

  test.beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-host-isolation-')));
    home = join(root, 'home');
    markers = join(root, 'markers');
    mkdirSync(markers);
    for (const directory of [join(home, '.local', 'bin'), join(home, '.bun', 'bin')]) {
      mkdirSync(directory, { recursive: true });
      for (const name of PROVIDER_BINARIES) {
        const script = join(directory, name);
        writeFileSync(script, `#!/bin/sh\n: > '${join(markers, name)}'\necho "${name} 9.9.9-outside-fixture"\n`, 'utf8');
        chmodSync(script, 0o755);
      }
    }
    app = await launchInterleaf({ isolatedHome: home });
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('neither detects nor executes a provider outside the fixture PATH', async () => {
    const mainEnvironment = await app.electronApp.evaluate(() => ({ home: process.env.HOME, path: process.env.PATH }));
    expect(mainEnvironment).toEqual({ home, path: offlinePath() });

    const providers = await app.window.evaluate(async () => window.interleafAPI.ai.listProviders());
    const profiles = await app.window.evaluate(async () => window.interleafAPI.agent.listProfiles());

    // OpenRouter and the loopback provider are HTTP providers; every CLI
    // provider must be absent.
    expect(providers.filter((provider) => provider.installed).map((provider) => provider.id)).toEqual([]);
    expect(profiles.filter((profile) => profile.detection.availability === 'installed').map((profile) => profile.id)).toEqual([]);
    expect(readdirSync(markers)).toEqual([]);
    for (const name of PROVIDER_BINARIES) expect(existsSync(join(markers, name))).toBe(false);
  });

  test('refuses every unhandled non-loopback request from main, before and after the OpenRouter seam', async () => {
    const attempt = async (url: string): Promise<string> =>
      app.electronApp.evaluate(async (_, target) => {
        try {
          await fetch(target);
          return 'reached';
        } catch (error) {
          return error instanceof Error ? error.message : 'refused';
        }
      }, url);

    expect(await attempt('https://example.com/unknown?token=not-recorded')).toBe('E2E network guard refused a non-loopback request.');
    await configureOpenRouterTestSeam(app);
    expect(await attempt('https://openrouter.ai/api/v1/unlisted')).toBe('E2E network guard refused a non-loopback request.');
    expect(await refusedMainRequests(app.electronApp)).toEqual([
      'https://example.com/unknown',
      'https://openrouter.ai/api/v1/unlisted',
    ]);

    // The catalog and key check a Settings panel or connection test asks for
    // are answered from fixtures rather than the network.
    const connection = await app.window.evaluate(async () => window.interleafAPI.credentials.testOpenRouterConnection());
    expect(connection.success).toBe(true);
    expect(await refusedMainRequests(app.electronApp)).toHaveLength(2);
  });

  test('does not follow a loopback redirect to a destination it would refuse directly', async () => {
    let targetHits = 0;
    const server: Server = createServer((request, response) => {
      if (request.url === '/redirect') {
        const { port } = server.address() as AddressInfo;
        response.writeHead(302, { location: `http://localhost:${String(port)}/target` });
        response.end();
        return;
      }
      targetHits += 1;
      response.end('owned-local-target');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const attempt = async (url: string, redirect?: RequestRedirect): Promise<string> =>
      app.electronApp.evaluate(
        async (_, request) => {
          try {
            const response = await fetch(request.url, request.redirect === undefined ? undefined : { redirect: request.redirect });
            return `reached ${String(response.status)} ${await response.text()}`;
          } catch (error) {
            return error instanceof Error ? error.message : 'refused';
          }
        },
        { url, redirect },
      );
    try {
      // The literal loopback fixture stays reachable, a loopback host name does not.
      expect(await attempt(`http://127.0.0.1:${String(port)}/target`)).toBe('reached 200 owned-local-target');
      expect(targetHits).toBe(1);
      expect(await attempt(`http://localhost:${String(port)}/target`)).toBe('E2E network guard refused a non-loopback request.');
      expect(targetHits).toBe(1);

      // A redirect is refused rather than followed, even when the caller asks to follow it.
      for (const redirect of [undefined, 'follow'] as const) {
        expect(await attempt(`http://127.0.0.1:${String(port)}/redirect`, redirect)).not.toMatch(/^reached/);
      }
      expect(targetHits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });
});
