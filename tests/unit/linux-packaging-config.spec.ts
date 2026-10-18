import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import packageJson from '../../package.json';

/**
 * Linux packaging configuration contract.
 *
 * Interleaf ships an Arch/Omarchy package, so `electron-builder.yml` has to
 * keep properties that are easy to lose in an unrelated packaging edit:
 *
 *  - the pacman target stays in the Linux target list;
 *  - `linux.executableName` and package.json `desktopName` stay equal to
 *    productName, so the installed entry is `Interleaf.desktop` and matches
 *    the desktop name Electron reports at runtime;
 *  - the generated desktop entry keeps `StartupWMClass=Interleaf`, which is
 *    the Wayland `app_id` Electron reports and the only key Hyprland, Waybar
 *    and Walker can use to bind a running window to the launcher entry;
 *  - `sharp` and `@img` stay outside the asar (ADR 0013), because the
 *    isolated raster worker loads the native decoder from the unpacked path.
 *
 * The assertions are deliberately dependency-free: the config is read as text
 * and inspected with a small indentation walker rather than a YAML parser, so
 * this spec adds no dependency to the project.
 */

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, 'electron-builder.yml');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'linux-package.yml');

const configText = readFileSync(CONFIG_PATH, 'utf8');
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');

/** Significant lines only: blank lines and whole-line comments are dropped. */
function significantLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
}

/** The indented body of a top-level `key:` mapping. */
function topLevelBlock(text: string, key: string): string[] {
  const lines = significantLines(text);
  const start = lines.indexOf(`${key}:`);
  expect(start, `expected a top-level "${key}:" block`).toBeGreaterThanOrEqual(0);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) {
      break;
    }
    body.push(line);
  }
  return body;
}

/** The `- item` entries of `<indent><key>:` inside an already-extracted block. */
function listItems(block: readonly string[], key: string, indent: string): string[] {
  const start = block.indexOf(`${indent}${key}:`);
  expect(start, `expected "${key}:" in the block`).toBeGreaterThanOrEqual(0);

  const itemPrefix = `${indent}  - `;
  const items: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (!line.startsWith(itemPrefix)) {
      break;
    }
    items.push(unquote(line.slice(itemPrefix.length).trim()));
  }
  return items;
}

/** The scalar value of `<indent><key>: value` inside an extracted block. */
function scalar(block: readonly string[], key: string, indent: string): string {
  const prefix = `${indent}${key}:`;
  const line = block.find((candidate) => candidate.startsWith(`${prefix} `));
  expect(line, `expected "${key}:" with a value in the block`).toBeDefined();
  return unquote((line ?? '').slice(prefix.length).trim());
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

describe('electron-builder Linux configuration', () => {
  const linux = topLevelBlock(configText, 'linux');
  const pacman = topLevelBlock(configText, 'pacman');

  it('builds an Arch/Omarchy package alongside AppImage and deb', () => {
    expect(listItems(linux, 'target', '  ')).toEqual(['AppImage', 'deb', 'pacman']);
  });

  it('names the binary and desktop entry after productName, matching the runtime desktop name', () => {
    const productName = scalar(significantLines(configText), 'productName', '');
    expect(productName).toBe(packageJson.productName);
    // Unset, electron-builder defaults executableName to the lowercase package
    // name and installs /opt/Interleaf/interleaf and interleaf.desktop.
    expect(scalar(linux, 'executableName', '  ')).toBe(productName);
    // Electron's desktop name, and so the Wayland app_id, comes from
    // desktopName; without it Electron slugs app.name to interleaf.desktop.
    expect(packageJson.desktopName).toBe(`${productName}.desktop`);
  });

  it('declares the Wayland window class Hyprland and Waybar match on', () => {
    expect(linux).toContain('  desktop:');
    expect(linux).toContain('    entry:');
    // Electron derives the app_id from package.json desktopName and main pins
    // the X11 WM_CLASS to the product name, so the entry must say "Interleaf".
    expect(scalar(linux, 'StartupWMClass', '      ')).toBe('Interleaf');
    expect(scalar(linux, 'GenericName', '      ')).toBe('Document Reader');
  });

  // The desktop entry's MimeType comes from `fileAssociations`, so a
  // hand-written list here could only drift from what is registered.
  it('leaves MimeType to fileAssociations instead of a hand-written list', () => {
    expect(linux.some((line) => line.trimStart().startsWith('MimeType:'))).toBe(false);
    expect(linux.some((line) => line.trimStart().startsWith('mimeTypes:'))).toBe(false);
  });

  it('names the pacman artifact so pacman -U gets a conventional filename', () => {
    expect(scalar(pacman, 'artifactName', '  ')).toMatch(/\.pkg\.tar\.xz$/);
  });

  it('replaces the stale default pacman dependency list', () => {
    const depends = listItems(pacman, 'depends', '  ');
    expect(depends).toContain('gtk3');
    expect(depends).toContain('nss');
    // libsecret backs Electron safeStorage; the credential vault fails closed
    // without a Secret Service provider.
    expect(depends).toContain('libsecret');
    // Both were dropped from the Arch repositories and would make the
    // installation fail to resolve.
    expect(depends).not.toContain('http-parser');
    expect(depends).not.toContain('libappindicator-gtk3');
  });

  it('keeps the native raster decoder outside the asar (ADR 0013)', () => {
    const unpacked = listItems(significantLines(configText), 'asarUnpack', '');
    expect(unpacked).toContain('**/node_modules/sharp/**');
    expect(unpacked).toContain('**/node_modules/@img/**');
  });
});

describe('Linux packaging workflow', () => {
  it('builds and verifies the AppImage, deb and pacman artifacts without secrets', () => {
    expect(workflowText).toContain('npx electron-builder --linux AppImage deb pacman --publish never');
    expect(workflowText).toContain('release/*.deb');
    expect(workflowText).toContain('release/*.pkg.tar.*');
    expect(workflowText).toContain("tags: ['v*']");
    expect(workflowText).toContain("grep -q '^StartupWMClass=Interleaf$'");
    expect(workflowText).toContain("require_entry 'opt/Interleaf/Interleaf'");
    expect(workflowText).toContain("require_entry 'usr/share/applications/Interleaf.desktop'");
    expect(workflowText).toContain('app.asar.unpacked/node_modules/sharp/');
    expect(workflowText).toContain('app.asar.unpacked/node_modules/@img/');
    expect(workflowText).not.toContain('secrets.');
  });
});
