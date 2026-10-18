import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPIMAGE_README_NAME, afterAllArtifactBuild, appImageReadme } from '../../electron.appimage-readme';

/**
 * The electron-builder hook writes the install README beside each built
 * AppImage, in whatever output directory the build used, and leaves every
 * other target's output alone.
 */

let output = '';

beforeEach(() => {
  output = mkdtempSync(join(tmpdir(), 'interleaf-appimage-readme-'));
});
afterEach(() => {
  rmSync(output, { recursive: true, force: true });
});

function built(...names: string[]): string[] {
  return names.map((name) => {
    writeFileSync(join(output, name), `bytes of ${name}`);
    return join(output, name);
  });
}

describe('AppImage README hook', () => {
  it('writes the README beside the AppImage, naming the built file, and returns it', () => {
    const nested = join(output, 'custom', 'dist');
    mkdirSync(nested, { recursive: true });
    const appImage = join(nested, 'Interleaf-0.5.1.AppImage');
    writeFileSync(appImage, 'appimage');
    const pacman = join(nested, 'interleaf-0.5.1-x64.pkg.tar.xz');
    writeFileSync(pacman, 'pacman');

    expect(afterAllArtifactBuild({ artifactPaths: [appImage, pacman] })).toEqual([join(nested, APPIMAGE_README_NAME)]);
    const readme = readFileSync(join(nested, APPIMAGE_README_NAME), 'utf8');
    expect(readme).toBe(appImageReadme('Interleaf-0.5.1.AppImage'));
    expect(readme).toContain('chmod +x ~/Applications/Interleaf-0.5.1.AppImage');
    expect(readme).not.toContain('{{');
    expect(readdirSync(nested).sort()).toEqual([APPIMAGE_README_NAME, 'Interleaf-0.5.1.AppImage', 'interleaf-0.5.1-x64.pkg.tar.xz'].sort());
  });

  it('refreshes an existing README instead of keeping stale text', () => {
    const [appImage = ''] = built('Interleaf-0.5.1.AppImage');
    writeFileSync(join(output, APPIMAGE_README_NAME), 'stale');
    afterAllArtifactBuild({ artifactPaths: [appImage] });
    expect(readFileSync(join(output, APPIMAGE_README_NAME), 'utf8')).toBe(appImageReadme('Interleaf-0.5.1.AppImage'));
  });

  it.each([
    ['macOS', ['Interleaf-0.5.1-arm64.dmg', 'Interleaf-0.5.1-arm64-mac.zip', 'Interleaf-0.5.1-arm64-mac.zip.blockmap']],
    ['Windows', ['Interleaf Setup 0.5.1.exe', 'Interleaf Setup 0.5.1.exe.blockmap']],
    ['deb and pacman', ['interleaf_0.5.1_amd64.deb', 'interleaf-0.5.1-x64.pkg.tar.xz']],
    ['--dir', []],
  ])('leaves %s output alone', (_label, names) => {
    const artifacts = built(...names);
    expect(afterAllArtifactBuild({ artifactPaths: artifacts })).toEqual([]);
    expect(readdirSync(output).sort()).toEqual([...names].sort());
  });

  it('keeps the instructions short and free of unsafe advice', () => {
    const readme = appImageReadme('Interleaf-0.5.1.AppImage');
    expect(readme.trimEnd().split('\n').length).toBeLessThanOrEqual(40);
    expect(readme).toMatch(/^[\x20-\x7e\n]*$/);
    for (const required of ['Settings > About & Updates', 'libfuse2t64', 'libfuse2', 'https://docs.appimage.org/user-guide/troubleshooting/fuse.html']) {
      expect(readme).toContain(required);
    }
    expect(readme).not.toMatch(/--no-sandbox|sudo \.\/|sudo ~|chmod 4755|sysctl|apparmor|apt install fuse\b/i);
  });
});
