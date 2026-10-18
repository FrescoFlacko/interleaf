import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMinimalChildEnvironment, execFileBounded, spawnPiped } from '@main/agents/process-runner';
import { defaultIsGitRepository } from '@main/agents/mode-resolver';

const node = process.execPath;
const bounded = { shell: false, encoding: 'utf8', env: buildMinimalChildEnvironment(), timeout: 5_000, maxBuffer: 4_096, windowsHide: true } as const;
/** A parent variable no allowlist names; a child must never inherit it. */
const PROBE = 'INTERLEAF_PARENT_ONLY_PROBE';
const printProbe = `process.stdout.write(process.env.${PROBE} ?? 'absent')`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('execFileBounded', () => {
  it('passes argv as tokens, never through a shell', async () => {
    const result = await execFileBounded(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); echo also'], bounded);
    expect(result.stdout).toBe('$(echo injected); echo also');
  });

  it('rejects output beyond the stated cap', async () => {
    await expect(execFileBounded(node, ['-e', 'process.stdout.write("x".repeat(8192))'], bounded)).rejects.toThrow(/maxBuffer/u);
  });

  it('kills a child that outlives the stated timeout', async () => {
    await expect(execFileBounded(node, ['-e', 'setTimeout(() => {}, 10_000)'], { ...bounded, timeout: 200 })).rejects.toMatchObject({ killed: true });
  });

  it('gives the child only the stated minimal environment, not the parent\'s', async () => {
    vi.stubEnv(PROBE, 'parent-secret');
    const result = await execFileBounded(node, ['-e', printProbe], { ...bounded, env: buildMinimalChildEnvironment() });
    expect(result.stdout).toBe('absent');
  });
});

describe('spawnPiped', () => {
  it('passes argv as tokens and pipes all three streams', async () => {
    const child = spawnPiped(node, ['-e', 'process.stdin.pipe(process.stdout)'], { shell: false, env: buildMinimalChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stdin.end('$HOME `id`');
    const code = await new Promise<number | null>((resolve) => { child.once('close', resolve); });
    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('$HOME `id`');
  });

  it('gives the child only the stated minimal environment, not the parent\'s', async () => {
    vi.stubEnv(PROBE, 'parent-secret');
    const child = spawnPiped(node, ['-e', printProbe], { shell: false, env: buildMinimalChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stdin.end();
    await new Promise<void>((resolve) => { child.once('close', () => { resolve(); }); });
    expect(Buffer.concat(chunks).toString('utf8')).toBe('absent');
  });
});

describe('production Git detection', () => {
  // A POSIX shell stand-in for `git`, found first on the inherited PATH,
  // records what the real call site's child can see.
  it.skipIf(process.platform === 'win32')('runs git without the parent\'s non-allowlisted variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-git-env-'));
    try {
      const seen = join(root, 'seen');
      await writeFile(join(root, 'git'), `#!/bin/sh\nprintf '%s' "\${${PROBE}-absent}" > '${seen}'\nexit 1\n`);
      await chmod(join(root, 'git'), 0o755);
      vi.stubEnv('PATH', [root, process.env.PATH].join(delimiter));
      vi.stubEnv(PROBE, 'parent-secret');
      await expect(defaultIsGitRepository(root)).resolves.toBe(false);
      await expect(readFile(seen, 'utf8')).resolves.toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
