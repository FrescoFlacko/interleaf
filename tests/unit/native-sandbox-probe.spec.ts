import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSandboxCapabilityProber, NATIVE_SANDBOX_CONTRACTS } from '@main/agents/native-sandbox-probe';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { Logger } from '@main/logging/logger';
import { waitForFile } from '../helpers/wait-for-file';
import { silentLogger } from '../helpers/silent-logger';

/**
 * Item Q: Native Restricted requires an actual bounded, non-inference proof.
 *
 * These tests drive the real prober against a real child process, because the
 * claim under test is "the CLI proves it", not "the code believes a flag".
 */

const CODEX_EXEC_HELP = [
  'Usage: codex exec [OPTIONS] [PROMPT]',
  '  -s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]',
  '      --json                    Print events to stdout as JSONL',
  '      --skip-git-repo-check     Allow running outside a Git repository',
  '  -c, --config <key=value>      Override a configuration value',
].join('\n');

const CODEX_RESUME_HELP = [
  'Usage: codex exec resume [OPTIONS] [SESSION_ID]',
  '      --json                 Print events to stdout as JSONL',
  '      --skip-git-repo-check  Allow running outside a Git repository',
  '  -m, --model <MODEL>        Model to use',
  '  -c, --config <key=value>   Override a configuration value',
].join('\n');

type FakeCliScript = {
  readonly version?: string;
  readonly execHelp?: string;
  readonly resumeHelp?: string;
  readonly exitCode?: number;
  /** Emits more than the probe's byte bound, so the run must be discarded. */
  readonly flood?: boolean;
  readonly hang?: boolean;
  /**
   * When this file exists the CLI misbehaves. It lets a test change what the
   * CLI *says* without changing the executable at all, which is the only way
   * to prove that a call really re-ran the probes rather than answering from
   * an identity-keyed cache.
   */
  readonly driftPath?: string;
  /** Padding, so a rewritten script can keep the previous file's byte length. */
  readonly padTo?: number;
};

function script(shape: FakeCliScript): string {
  const body = {
    version: shape.version ?? 'codex-cli 0.149.1',
    execHelp: shape.execHelp ?? CODEX_EXEC_HELP,
    resumeHelp: shape.resumeHelp ?? CODEX_RESUME_HELP,
    exitCode: shape.exitCode ?? 0,
    flood: shape.flood === true,
    hang: shape.hang === true,
    driftPath: shape.driftPath ?? null,
  };
  const source = [
    '#!/usr/bin/env node',
    `const shape = ${JSON.stringify(body)};`,
    'const args = process.argv.slice(2);',
    'if (shape.driftPath && require("node:fs").existsSync(shape.driftPath)) { process.exit(9); }',
    // A hanging CLI marks itself started next to its own executable, so a test
    // can act on a probe that is genuinely in flight instead of guessing a delay.
    'if (shape.hang) { require("node:fs").writeFileSync(process.argv[1] + ".started", "ready"); setInterval(() => {}, 1000); }',
    'else if (shape.flood) { process.stdout.write("x".repeat(1024 * 1024)); process.exit(0); }',
    'else {',
    '  if (args[0] === "--version") process.stdout.write(shape.version + "\\n");',
    '  else if (args[0] === "exec" && args[1] === "resume") process.stdout.write(shape.resumeHelp + "\\n");',
    '  else if (args[0] === "exec") process.stdout.write(shape.execHelp + "\\n");',
    '  process.exit(shape.exitCode);',
    '}',
  ].join('\n');
  if (shape.padTo === undefined || source.length >= shape.padTo) return source;
  return source + '\n'.padEnd(shape.padTo - source.length, ' ');
}

async function writeFakeCli(path: string, shape: FakeCliScript): Promise<void> {
  await writeFile(path, script(shape), 'utf8');
  await chmod(path, 0o755);
}

/** The prober's own per-probe bound; shutdown must not wait for it. */
const PROBE_BOUND_MS = 10_000;

function codexProfile(binaryPath: string, overrides: Partial<MainAgentProfile> = {}): MainAgentProfile {
  return {
    id: 'codex',
    providerId: 'codex',
    name: 'Codex',
    binaryPath,
    defaultArgs: [...(NATIVE_SANDBOX_CONTRACTS.codex?.startArgs ?? [])],
    defaultModel: null,
    configuredModels: [],
    reasoningEffort: null,
    permissionMode: 'normal',
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', binaryPath, version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

async function withProber(
  shape: FakeCliScript,
  run: (context: {
    readonly prober: NativeSandboxCapabilityProber;
    readonly binaryPath: string;
    readonly root: string;
    readonly rewrite: (next: FakeCliScript) => Promise<void>;
  }) => Promise<void>,
  options: { readonly ttlMs?: number; readonly log?: Logger } = {},
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-native-probe-')));
  const binaryPath = join(root, 'codex');
  const probeCwd = join(root, 'probe-cwd');
  await mkdir(probeCwd, { recursive: true });
  await writeFakeCli(binaryPath, shape);
  // No TTL by default: every call re-proves, which is what start and resume require.
  const prober = new NativeSandboxCapabilityProber({ log: options.log ?? silentLogger, probeCwd, ttlMs: options.ttlMs ?? 0 });
  try {
    await run({
      prober,
      binaryPath,
      root,
      rewrite: async (next) => { await writeFakeCli(binaryPath, next); },
    });
  } finally {
    await prober.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('Native Restricted capability probe', () => {
  it('verifies a conforming CLI and binds the proof to the exact argv contract', async () => {
    await withProber({}, async ({ prober, binaryPath }) => {
      const verified = await prober.verify(codexProfile(binaryPath));

      expect(verified).not.toBeNull();
      expect(verified?.contractId).toBe('codex-exec-sandbox-workspace-write-v1');
      expect(verified?.startArgs).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
      expect(verified?.resumeSandboxArgs).toEqual(['-c', 'sandbox_mode="workspace-write"']);
      expect(verified?.executableFingerprint.length).toBeGreaterThan(0);
    });
  });

  it('follows a launcher symlink but fingerprints the resolved file', async () => {
    await withProber({}, async ({ prober, binaryPath, root }) => {
      const launcher = join(root, 'bin-codex');
      await symlink(binaryPath, launcher);

      const direct = await prober.verify(codexProfile(binaryPath));
      const viaLink = await prober.verify(codexProfile(launcher));

      expect(viaLink).not.toBeNull();
      expect(viaLink?.executableFingerprint).toBe(direct?.executableFingerprint);
    });
  });

  describe.each([
    {
      caseName: 'sandbox selector disappeared from exec help',
      shape: { execHelp: CODEX_EXEC_HELP.replaceAll('--sandbox', '--mode') },
      expectedWarn: 'native sandbox capability probe found drifted help output',
    },
    {
      caseName: 'workspace-write sandbox level disappeared from exec help',
      shape: { execHelp: CODEX_EXEC_HELP.replaceAll('workspace-write', 'writable') },
      expectedWarn: 'native sandbox capability probe found drifted help output',
    },
    {
      caseName: 'config flag disappeared from resume help',
      shape: { resumeHelp: CODEX_RESUME_HELP.replaceAll('--config', '--set') },
      expectedWarn: 'native sandbox capability probe found drifted help output',
    },
    {
      caseName: 'forbidden resume-side sandbox selector appeared',
      shape: { resumeHelp: `${CODEX_RESUME_HELP}\n  -s, --sandbox <SANDBOX_MODE>  New in this release` },
      expectedWarn: 'native sandbox capability probe found an unexpected flag',
    },
    {
      caseName: 'help output is empty',
      shape: { execHelp: '', resumeHelp: '' },
      expectedWarn: 'native sandbox capability probe found drifted help output',
    },
  ])('treats help-output drift as an unproven capability ($caseName)', ({ shape, expectedWarn }) => {
    it('verifies drift rejection through real process probe and warning diagnostic', async () => {
      const warnMessages: string[] = [];
      const testLogger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => { warnMessages.push(message); },
        error: () => undefined,
      };
      await withProber(shape, async ({ prober, binaryPath }) => {
        const verified = await prober.verify(codexProfile(binaryPath));
        expect(verified).toBeNull();
        expect(warnMessages).toContain(expectedWarn);
      }, { log: testLogger });
    }, 15_000);
  });

  it('rejects an unsupported version, a failing probe, a flood, and a hang', async () => {
    const failures: readonly FakeCliScript[] = [
      { version: 'codex-cli 0.4.2' },
      { version: 'unreleased build' },
      { exitCode: 3 },
      { flood: true },
      // A CLI that never answers is uncertainty, resolved by the probe's own bound.
      { hang: true },
    ];
    for (const failure of failures) {
      await withProber(failure, async ({ prober, binaryPath }) => {
        expect(await prober.verify(codexProfile(binaryPath))).toBeNull();
      });
    }
  }, 60_000);

  it('withdraws the capability as soon as the binary is replaced', async () => {
    await withProber({}, async ({ prober, binaryPath, rewrite }) => {
      const before = await prober.verify(codexProfile(binaryPath));
      expect(before).not.toBeNull();

      // Same path, different file: the previous proof described another binary.
      await rewrite({ execHelp: 'Usage: totally-different-tool' });
      const after = await prober.verify(codexProfile(binaryPath));
      expect(after).toBeNull();

      // Restoring the same conforming binary re-proves it. The fingerprint is
      // a content digest, so identical contents at the same canonical path
      // legitimately produce the same value; the withdrawal above came from
      // the file's contents differing, not from its timestamps.
      await rewrite({});
      const again = await prober.verify(codexProfile(binaryPath));
      expect(again).not.toBeNull();
      expect(again?.executableFingerprint).toBe(before?.executableFingerprint);
    });
  });

  it('withdraws the capability after a replacement that preserves size, inode, and mtime', async () => {
    await withProber({}, async ({ prober, binaryPath }) => {
      const before = await prober.verify(codexProfile(binaryPath));
      expect(before).not.toBeNull();
      const original = await stat(binaryPath);

      // The kind of swap a metadata-only fingerprint cannot see: the same
      // inode (writeFile truncates in place), the same byte length, and the
      // original timestamps restored afterwards. Only the contents differ.
      await writeFile(binaryPath, script({
        execHelp: 'Usage: totally-different-tool',
        padTo: original.size,
      }), 'utf8');
      await utimes(binaryPath, original.atime, original.mtime);
      const replaced = await stat(binaryPath);
      expect(replaced.ino).toBe(original.ino);
      expect(replaced.size).toBe(original.size);
      expect(Math.round(replaced.mtimeMs)).toBe(Math.round(original.mtimeMs));

      expect(await prober.verify(codexProfile(binaryPath))).toBeNull();
    });
  });

  it('re-runs the bounded probes for a forced fresh proof inside the cache window', async () => {
    await withProber({}, async ({ prober, binaryPath, root }) => {
      const driftPath = join(root, 'drift');
      await writeFakeCli(binaryPath, { driftPath });
      const profile = codexProfile(binaryPath);

      expect(await prober.verify(profile)).not.toBeNull();

      // The executable is untouched, so its identity — and therefore the cache
      // key — is unchanged. Only its behaviour drifted.
      await writeFile(driftPath, 'drifted\n', 'utf8');

      expect(await prober.verify(profile)).not.toBeNull();
      expect(await prober.verify(profile, { fresh: true })).toBeNull();
    }, { ttlMs: 5 * 60 * 1_000 });
  });

  it('never reaches the CLI for a profile that cannot hold the capability', async () => {
    await withProber({}, async ({ prober, binaryPath }) => {
      const unprovable: readonly Partial<MainAgentProfile>[] = [
        { isCustom: true },
        { unsafe: true },
        { permissionMode: 'bypassPermissions' },
        { providerId: 'antigravity' },
        { providerId: 'claude-code' },
        // The profile's own argv no longer starts with the sandboxed contract.
        { defaultArgs: ['exec', '--json'] },
        { defaultArgs: ['exec', '--json', '--sandbox', 'danger-full-access'] },
        { detection: { availability: 'not-installed', binaryPath: null, version: null, checkedAt: new Date().toISOString(), errorMessage: null } },
      ];
      for (const overrides of unprovable) {
        expect(await prober.verify(codexProfile(binaryPath, overrides))).toBeNull();
      }
    });
  });

  it('fails closed when the executable is missing or is not a regular file', async () => {
    await withProber({}, async ({ prober, root }) => {
      expect(await prober.verify(codexProfile(join(root, 'absent')))).toBeNull();
      expect(await prober.verify(codexProfile(root))).toBeNull();
    });
  });

  it('answers null once closed, so a shutting-down service cannot grant the mode', async () => {
    await withProber({}, async ({ prober, binaryPath }) => {
      expect(await prober.verify(codexProfile(binaryPath))).not.toBeNull();
      await prober.close();
      expect(await prober.verify(codexProfile(binaryPath))).toBeNull();
    });
  });

  it('cancels an in-flight probe and reaps its child when shutdown closes the prober', async () => {
    // Item R: `close()` used to mark the prober closed and clear its cache
    // while leaving a running probe child to its own 10s bound, so shutdown
    // waited on a process nobody was going to use the answer from.
    await withProber({}, async ({ prober, binaryPath, rewrite }) => {
      const readyPath = `${binaryPath}.started`;
      await rewrite({ hang: true });
      const startedAt = Date.now();
      const pending = prober
        .verify(codexProfile(binaryPath))
        .then((result) => ({ result, elapsedMs: Date.now() - startedAt }));
      await waitForFile(readyPath);

      await prober.close();
      const closeElapsedMs = Date.now() - startedAt;
      const settled = await pending;

      // The awaiting caller is answered by the cancellation, not by the
      // probe's own 10s bound, and `strictCleanup` means the run settles only
      // once the child tree is proven gone — so this is also the reaping proof.
      expect(settled.result).toBeNull();
      expect(settled.elapsedMs).toBeLessThan(PROBE_BOUND_MS / 2);
      // close() drains: it does not return while a probe child is still alive.
      expect(settled.elapsedMs).toBeLessThanOrEqual(closeElapsedMs);
      expect(await prober.verify(codexProfile(binaryPath))).toBeNull();
    });
  }, 60_000);

  it('owns a verification suspended on the executable fingerprint when close lands', async () => {
    // Item R: `close()` only ever cancelled probe *children*, and verification
    // was tracked from the probe onwards — so a close that landed while the
    // fingerprint was still being read saw no work at all, drained, and
    // returned. The attempt then woke up and spawned a probe child after
    // shutdown had finished. Nothing here depends on timing: the fingerprint
    // is held open until the test releases it.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-native-probe-race-')));
    const binaryPath = join(root, 'codex');
    const probeCwd = join(root, 'probe-cwd');
    await mkdir(probeCwd, { recursive: true });
    // A CLI that records the fact it was executed at all, so "no probe ran
    // after close" is asserted rather than inferred from a null answer.
    const invokedPath = `${binaryPath}.invoked`;
    await writeFile(binaryPath, '#!/bin/sh\ntouch "$0.invoked"\nexit 0\n', { mode: 0o755 });
    await chmod(binaryPath, 0o755);
    const { promise: held, resolve: releaseFingerprint } = Promise.withResolvers<undefined>();
    const order: string[] = [];
    const prober = new NativeSandboxCapabilityProber({
      log: silentLogger,
      probeCwd,
      ttlMs: 0,
      fingerprint: async () => { await held; return 'deterministic-fingerprint'; },
    });
    try {
      const pending = prober.verify(codexProfile(binaryPath), { fresh: true })
        .then((result) => { order.push('verify'); return result; });
      const closing = prober.close().then(() => { order.push('close'); });

      releaseFingerprint(undefined);
      const [result] = await Promise.all([pending, closing]);

      expect(result).toBeNull();
      // close() owns the attempt: it does not return before the verification
      // it admitted has settled, and no probe ran on the far side of it.
      expect(order).toEqual(['verify', 'close']);
      expect(existsSync(invokedPath)).toBe(false);
      expect(await prober.verify(codexProfile(binaryPath), { fresh: true })).toBeNull();
      expect(existsSync(invokedPath)).toBe(false);
    } finally {
      await prober.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a contract only for adapters that can actually prove one', () => {
    // Documented deliberately: a provider with no truthful proof stays absent
    // rather than being granted the mode on the strength of a capability bit.
    expect(Object.keys(NATIVE_SANDBOX_CONTRACTS)).toEqual(['codex']);
  });
});
