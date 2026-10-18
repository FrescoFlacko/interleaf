import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packagedExecutable,
  packagedStartupEnvironment,
  packagedStartupProblems,
  packagedStartupTargetProblems,
} from '../../electron.package-startup';

/**
 * The launch itself is exercised against a real package (docs/PACKAGING.md);
 * these pin what the smoke check refuses and what it counts as a failure.
 */

describe('packaged startup smoke check', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('refuses a bundle without its executable and accepts one outside /Applications', () => {
    scratch = mkdtempSync(join(tmpdir(), 'interleaf-startup-check-'));
    const app = join(scratch, 'Interleaf.app');
    expect(packagedStartupTargetProblems(app)).toEqual([`${packagedExecutable(app)} does not exist`]);

    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(packagedExecutable(app), '');
    expect(packagedStartupTargetProblems(app)).toEqual([]);
  });

  it('gives the app only an OS PATH and sandboxed HOME, TMPDIR and profile', () => {
    expect(packagedStartupEnvironment('/tmp/sandbox')).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/tmp/sandbox/home',
      TMPDIR: '/tmp/sandbox/tmp',
      INTERLEAF_USER_DATA: '/tmp/sandbox/user-data',
    });
  });

  it('fails when no window opens, or the app ran from the wrong cwd, profile or mode', () => {
    expect(packagedStartupProblems(undefined, '/p')[0]).toMatch(/^no window opened within 60 s/);
    expect(packagedStartupProblems({ userData: '/p', cwd: '/', isPackaged: true }, '/p')).toEqual([]);
    expect(packagedStartupProblems({ userData: '/real', cwd: '/repo', isPackaged: false }, '/p')).toEqual([
      'app ran from /repo, not /',
      'app used profile /real, not the isolated /p',
      'app did not report itself as packaged',
    ]);
  });
});
