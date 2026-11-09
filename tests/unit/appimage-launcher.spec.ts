import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { afterPack } from '../../electron.appimage-launcher';

describe('AppImage launcher', () => {
  it('passes arguments unchanged even when user namespaces are unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'interleaf-appimage-'));
    try {
      afterPack({ electronPlatformName: 'linux', appOutDir: directory, targets: [{ name: 'appImage' }] });
      // A failed namespace probe must never cause an automatic sandbox bypass.
      writeFileSync(join(directory, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(directory, 'Interleaf'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const output = execFileSync(join(directory, 'AppRun'), ['example.pdf'], { encoding: 'utf8', env: { ...process.env, APPDIR: directory } });
      expect(output).toBe('example.pdf\n');
      expect(readFileSync(join(directory, 'AppRun'), 'utf8')).not.toContain('--no-sandbox');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves non-AppImage builds untouched', () => {
    const directory = mkdtempSync(join(tmpdir(), 'interleaf-appimage-'));
    try {
      afterPack({ electronPlatformName: 'linux', appOutDir: directory, targets: [{ name: 'deb' }] });
      expect(() => readFileSync(join(directory, 'AppRun'))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
