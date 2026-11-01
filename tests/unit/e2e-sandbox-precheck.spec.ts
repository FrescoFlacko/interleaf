import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The E2E workflow's setuid-helper step, executed as the hosted runner executes
 * it: the named step's own `run` block, written to a script and run by Bash with
 * errexit, in a synthetic checkout. `sudo` is a recording shell function, so
 * nothing privileged runs; a `sudo` placed first on PATH fails loudly if the
 * function were ever bypassed. The step must change exactly the regular,
 * non-symlink helper and must stop before either privileged command otherwise.
 */

const ROOT = join(__dirname, '..', '..');
const HELPER = 'node_modules/electron/dist/chrome-sandbox';
const STEP = "Set up Electron's setuid sandbox helper";
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'e2e.yml'), 'utf8');

/** The step's `run: |` block exactly as the runner receives it: every line until the block's indentation ends. */
function runBlock(source: string, name: string): string {
  const marker = `      - name: ${name}\n        run: |\n`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`no run block for step ${name}`);
  const lines: string[] = [];
  for (const line of source.slice(start + marker.length).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

const RECORDING_SUDO = 'sudo() { printf \'%s\\n\' "$*" >> "$SUDO_CALLS"; if [ "${SUDO_FAIL_ON:-}" = "$1" ]; then return 1; fi; }\n';
// GitHub runs a `run` block with no `shell:` as `bash -e {0}`; `shell: bash` would add pipefail.
const SHELLS = [['-e'], ['-e', '-o', 'pipefail']] as const;
type Layout = 'regular' | 'missing' | 'directory' | 'symlink-to-file' | 'symlink-to-directory' | 'dangling-symlink';
type Run = { readonly status: number | null; readonly calls: readonly string[]; readonly stderr: string };

let scratch = '';
let fixtures = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'interleaf-sandbox-precheck-'));
  const guard = join(scratch, 'guard-bin');
  mkdirSync(guard);
  writeFileSync(join(guard, 'sudo'), '#!/bin/sh\necho "real sudo reached: $*" >&2\nexit 97\n');
  chmodSync(join(guard, 'sudo'), 0o755);
});

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

/** A synthetic checkout whose helper path has the given shape, plus every entry's owner and mode. */
function checkout(layout: Layout): { readonly dir: string; readonly before: string } {
  const dir = join(scratch, `checkout-${String(++fixtures)}`);
  mkdirSync(join(dir, 'node_modules', 'electron', 'dist'), { recursive: true });
  const helper = join(dir, HELPER);
  const outsideFile = join(dir, 'outside-file');
  const outsideDir = join(dir, 'outside-dir');
  writeFileSync(outsideFile, 'synthetic target');
  mkdirSync(outsideDir);
  if (layout === 'regular') writeFileSync(helper, 'synthetic helper');
  if (layout === 'directory') mkdirSync(helper);
  if (layout === 'symlink-to-file') symlinkSync(outsideFile, helper);
  if (layout === 'symlink-to-directory') symlinkSync(outsideDir, helper);
  if (layout === 'dangling-symlink') symlinkSync(join(dir, 'absent'), helper);
  return { dir, before: ownership(dir) };
}

function ownership(dir: string): string {
  const entries = readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
  return entries.map((entry) => {
    const stat = lstatSync(join(dir, entry));
    return `${entry} ${String(stat.uid)}:${String(stat.gid)} ${stat.mode.toString(8)}`;
  }).join('\n');
}

function execute(block: string, dir: string, flags: readonly string[], failOn = ''): Run {
  const script = join(dir, 'step.sh');
  const calls = join(dir, 'sudo-calls.txt');
  writeFileSync(script, RECORDING_SUDO + block);
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', ...flags, script], {
    cwd: dir,
    env: { PATH: `${join(scratch, 'guard-bin')}:/usr/bin:/bin`, SUDO_CALLS: calls, SUDO_FAIL_ON: failOn },
    encoding: 'utf8',
    timeout: 5_000,
  });
  let recorded: string[] = [];
  try {
    recorded = readFileSync(calls, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    recorded = [];
  }
  rmSync(script);
  rmSync(calls, { force: true });
  return { status: result.status, calls: recorded, stderr: result.stderr };
}

function runIn(block: string, layout: Layout, flags: readonly string[], failOn = ''): Run {
  const { dir, before } = checkout(layout);
  const run = execute(block, dir, flags, failOn);
  expect(ownership(dir), `${layout}: fixture owner and mode`).toBe(before);
  expect(run.stderr, 'the recording function, never a real sudo').not.toContain('real sudo reached');
  return run;
}

const block = runBlock(workflow, STEP);
const INVALID: readonly Layout[] = ['missing', 'directory', 'symlink-to-file', 'symlink-to-directory', 'dangling-symlink'];
const PRIVILEGED = [`chown root:root ${HELPER}`, `chmod 4755 ${HELPER}`];

describe("E2E workflow: Electron's setuid helper step", () => {
  it('is its own run block, between dependency install and build, using the default errexit shell', () => {
    expect(block).not.toMatch(/Xvfb|npm run build|playwright/u);
    const install = workflow.indexOf('run: npm ci');
    const step = workflow.indexOf(`- name: ${STEP}`);
    const build = workflow.indexOf('- name: Build');
    expect(install).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(step);
    // No `shell:` or `defaults:` override, so the hosted runner uses `bash -e`.
    expect(workflow).not.toMatch(/^\s*(shell|defaults):/mu);
    // Every privileged command is a plain `sudo` the recording function intercepts.
    const sudoLines = block.split('\n').filter((line) => line.includes('sudo'));
    expect(sudoLines.map((line) => line.trim())).toEqual(PRIVILEGED.map((call) => `sudo ${call.replace(HELPER, `"${HELPER}"`)}`));
  });

  for (const flags of SHELLS) {
    describe(`under bash ${flags.join(' ')}`, () => {
      it('changes the regular helper with exactly chown then chmod', () => {
        const run = runIn(block, 'regular', flags);
        expect(run.status).toBe(0);
        expect(run.calls).toEqual(PRIVILEGED);
      });

      it.each(INVALID)('stops before any privileged command when the helper is %s', (layout) => {
        const run = runIn(block, layout, flags);
        expect(run.status).not.toBe(0);
        expect(run.status).not.toBeNull();
        expect(run.calls).toEqual([]);
      });

      it('does not run chmod when chown fails', () => {
        const run = runIn(block, 'regular', flags, 'chown');
        expect(run.status).not.toBe(0);
        expect(run.calls).toEqual([PRIVILEGED[0]]);
      });
    });
  }

  it('would catch a step whose precheck is removed or does not fail closed', () => {
    const sudoOnly = `${block.split('\n').filter((line) => line.trim().startsWith('sudo ')).map((line) => line.trim()).join('\n')}\n`;
    const andList = `test -f "${HELPER}" && test ! -L "${HELPER}"\n${sudoOnly}`;
    for (const mutant of [sudoOnly, andList]) {
      const run = runIn(mutant, 'directory', ['-e']);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(PRIVILEGED);
    }
  });
});
