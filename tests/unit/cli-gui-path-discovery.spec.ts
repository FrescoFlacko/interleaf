import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAIProvider, createCliProviderDefinitions, resolveBinary } from '@main/ai/providers/cli-ai-provider';
import { BUILT_IN_AGENT_DEFINITIONS, detectAgentDefinition } from '@main/agents/agent-adapter';
import { ProcessRunner, type ProcessRunnerEvent } from '@main/agents/process-runner';
import { buildCliSearchPath, type CliSearchPathFs } from '@main/app/cli-search-path';
import { silentLogger } from '../helpers/silent-logger';

/**
 * A Finder/LaunchServices launch hands the app only the OS GUI PATH. These
 * tests reproduce that at the real resolver and spawn boundary — `/usr/bin/which`,
 * `execFile`, `spawn` and `#!/usr/bin/env node` — with fixture CLIs installed
 * in the per-user locations a login shell would normally put on PATH.
 */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const NODE_SCRIPT = [
  '#!/usr/bin/env node',
  "const args = process.argv.slice(2);",
  "if (args[0] === '--version') console.log('9.9.9 (fixture)');",
  "else if (args[0] === 'auth' && args[1] === 'status') console.log(JSON.stringify({ loggedIn: true }));",
  "else if (args[0] === '-p') process.stdin.on('data', () => undefined).on('end', () => console.log(JSON.stringify({ type: 'text_delta', text: 'fixture reply' })));",
  '',
].join('\n');
const SHELL_SCRIPT = '#!/bin/sh\necho "1.0.0 (fixture)"\n';

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

async function collect(events: AsyncIterable<ProcessRunnerEvent>): Promise<ProcessRunnerEvent[]> {
  const collected: ProcessRunnerEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe.runIf(process.platform === 'darwin')('provider CLI discovery under a Finder-launch PATH', () => {
  let root: string;
  let home: string;
  let nvmBin: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-gui-path-')));
    home = join(root, 'home');
    const localBin = join(home, '.local', 'bin');
    const bunBin = join(home, '.bun', 'bin');
    nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.23.1', 'bin');
    for (const directory of [localBin, bunBin, nvmBin, join(root, 'chat')]) mkdirSync(directory, { recursive: true });
    // Like a real nvm install, `node` lives only beside the CLI, so an
    // `#!/usr/bin/env node` script runs only when the child PATH carries it.
    symlinkSync(process.execPath, join(nvmBin, 'node'));
    writeExecutable(join(nvmBin, 'interleaf-fixture-pi'), NODE_SCRIPT);
    writeExecutable(join(localBin, 'interleaf-fixture-claude'), SHELL_SCRIPT);
    writeExecutable(join(bunBin, 'interleaf-fixture-omp'), SHELL_SCRIPT);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', FINDER_PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function claudeLikeProvider(binary: string): CliAIProvider {
    const claude = createCliProviderDefinitions().find((definition) => definition.id === 'claude');
    if (claude === undefined) throw new Error('claude definition missing');
    return new CliAIProvider({ ...claude, binary }, join(root, 'chat'), { logger: silentLogger });
  }

  it('resolves CLIs installed under ~/.local/bin, ~/.bun/bin and nvm to canonical paths', async () => {
    await expect(resolveBinary('interleaf-fixture-claude')).resolves.toBe(join(home, '.local', 'bin', 'interleaf-fixture-claude'));
    await expect(resolveBinary('interleaf-fixture-omp')).resolves.toBe(join(home, '.bun', 'bin', 'interleaf-fixture-omp'));
    await expect(resolveBinary('interleaf-fixture-pi')).resolves.toBe(join(nvmBin, 'interleaf-fixture-pi'));
  });

  it('reports a Reader Chat provider installed and signed in, then streams a turn through it', async () => {
    const provider = claudeLikeProvider('interleaf-fixture-pi');
    const status = await provider.detect();
    expect(status).toMatchObject({ installed: true, authentication: 'connected', version: '9.9.9 (fixture)' });

    const events = [];
    for await (const event of provider.streamChat({
      requestId: 'gui-path', modelId: null, systemPrompt: 'Reference data only.', contextXml: '<document/>',
      history: [], userMessage: 'Hello', sources: [], webSearch: false,
    })) events.push(event);
    expect(events).toEqual([{ type: 'token', token: 'fixture reply' }, { type: 'done' }]);
  });

  it('classifies a CLI that is genuinely absent as not installed rather than a failed sign-in check', async () => {
    const status = await claudeLikeProvider('interleaf-fixture-absent').detect();
    expect(status).toMatchObject({ installed: false, available: false, authentication: 'disconnected' });
  });

  it('detects an Agent Mode CLI and runs it as a child with the same usable PATH', async () => {
    const pi = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.id === 'pi');
    if (pi === undefined) throw new Error('pi definition missing');
    const profile = await detectAgentDefinition({ ...pi, binary: 'interleaf-fixture-pi' }, () => new Date(0));
    expect(profile.detection).toMatchObject({ availability: 'installed', version: '9.9.9 (fixture)' });
    expect(profile.binaryPath).toBe(join(nvmBin, 'interleaf-fixture-pi'));

    const run = new ProcessRunner({ timeoutMs: 10_000 }).run({ file: profile.binaryPath, args: ['--version'], cwd: root });
    const events = await collect(run.events);
    await run.completion;
    expect(events.flatMap((event) => (event.type === 'stdout' ? [event.text] : [])).join('')).toContain('9.9.9 (fixture)');
    expect(events.find((event) => event.type === 'ended')).toMatchObject({ exitCode: 0 });

    const absent = await detectAgentDefinition({ ...pi, binary: 'interleaf-fixture-absent' }, () => new Date(0));
    expect(absent.detection.availability).toBe('not-installed');
  });

  it('keeps an explicit per-run PATH override authoritative for Agent Mode children', async () => {
    const run = new ProcessRunner({ timeoutMs: 10_000 }).run({
      file: join(nvmBin, 'interleaf-fixture-pi'), args: ['--version'], cwd: root, env: { PATH: FINDER_PATH },
    });
    const events = await collect(run.events);
    await run.completion;
    // `env` cannot find node on the overridden PATH, so the fixture never runs.
    expect(events.find((event) => event.type === 'ended')).toMatchObject({ exitCode: 127 });
  });
});

describe('buildCliSearchPath', () => {
  const nvmRoot = '/Users/reader/.nvm/versions/node';
  function fakeFs(directories: readonly string[], nvmEntries: readonly string[] = []): CliSearchPathFs & { readonly limits: number[] } {
    const limits: number[] = [];
    return {
      limits,
      isDirectory: (path) => directories.includes(path),
      listDirectory: (path, limit) => {
        limits.push(limit);
        return path === nvmRoot ? nvmEntries.slice(0, limit) : [];
      },
    };
  }

  it('appends only existing well-known locations after the inherited PATH on macOS, newest nvm first', () => {
    const fileSystem = fakeFs([
      '/Users/reader/.local/bin', '/Users/reader/.bun/bin', '/opt/homebrew/bin', '/usr/local/bin',
      `${nvmRoot}/v22.23.1/bin`, `${nvmRoot}/v9.11.2/bin`, `${nvmRoot}/v22.3.0/bin`,
    ], ['v9.11.2', 'v22.3.0', 'system', '.DS_Store', 'v22.23.1', 'v23.0.0', 'v1.2.3/../../x']);
    expect(buildCliSearchPath({ platform: 'darwin', inheritedPath: FINDER_PATH, homeDirectory: '/Users/reader', fileSystem })).toBe([
      FINDER_PATH,
      '/Users/reader/.local/bin', '/Users/reader/.bun/bin',
      `${nvmRoot}/v22.23.1/bin`, `${nvmRoot}/v22.3.0/bin`, `${nvmRoot}/v9.11.2/bin`,
      '/opt/homebrew/bin', '/usr/local/bin',
    ].join(':'));
    expect(fileSystem.limits.every((limit) => limit <= 256)).toBe(true);
  });

  it('keeps a terminal PATH verbatim when it already carries every location', () => {
    const inheritedPath = '/opt/homebrew/bin:/Users/reader/.local/bin:/usr/bin:/bin';
    const fileSystem = fakeFs(['/opt/homebrew/bin', '/Users/reader/.local/bin']);
    expect(buildCliSearchPath({ platform: 'darwin', inheritedPath, homeDirectory: '/Users/reader', fileSystem })).toBe(inheritedPath);
  });

  it('ignores per-user locations for a relative or root home and never lists outside nvm', () => {
    const fileSystem = fakeFs(['/opt/homebrew/bin', '.local/bin']);
    expect(buildCliSearchPath({ platform: 'darwin', inheritedPath: FINDER_PATH, homeDirectory: '.', fileSystem }))
      .toBe(`${FINDER_PATH}:/opt/homebrew/bin`);
    expect(buildCliSearchPath({ platform: 'darwin', inheritedPath: FINDER_PATH, homeDirectory: '/', fileSystem }))
      .toBe(`${FINDER_PATH}:/opt/homebrew/bin`);
    expect(fileSystem.limits).toHaveLength(0);
  });

  it('leaves the inherited PATH untouched on every other platform', () => {
    const fileSystem = fakeFs(['/opt/homebrew/bin', '/usr/local/bin', '/home/reader/.local/bin']);
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      expect(buildCliSearchPath({ platform, inheritedPath: '/usr/bin:/bin', homeDirectory: '/home/reader', fileSystem })).toBe('/usr/bin:/bin');
      expect(buildCliSearchPath({ platform, inheritedPath: undefined, homeDirectory: '/home/reader', fileSystem })).toBeUndefined();
    }
  });
});

describe('resolveBinary missing-CLI classification', () => {
  const rejectWith = (error: object) => () => Promise.reject(Object.assign(new Error('Command failed'), error));

  it('reports a resolver that exits 1 on its own as an absent CLI', async () => {
    await expect(resolveBinary('claude', { platform: 'darwin', execFile: rejectWith({ code: 1, killed: false, signal: null }) }))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a killed, signalled or otherwise failed resolver as a probe failure', async () => {
    for (const error of [{ code: 1, killed: true, signal: 'SIGTERM' }, { code: null, killed: false, signal: 'SIGKILL' }, { code: 2, killed: false, signal: null }]) {
      await expect(resolveBinary('claude', { platform: 'darwin', execFile: rejectWith(error) }))
        .rejects.not.toMatchObject({ code: 'ENOENT' });
    }
  });
});
