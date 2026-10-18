import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AsarArchive,
  localDependencyProblems,
  lookupCandidates,
  packagedDependencyProblems,
  productionDependencyEdges,
  requiredProductionPackages,
} from '../../electron.package-dependencies';
import { macReleaseAppProblems, macReleaseBuildInputProblems, type ToolResult } from '../../electron.mac-release';

/**
 * The 0.2.0 arm64 DMG was built from a worktree whose node_modules was a
 * symlink; electron-builder only logged `cannot find path for dependency` and
 * shipped an app.asar without htmlparser2, which linkedom requires at startup.
 * The release must refuse such an install before building, and refuse such a
 * package before reporting success.
 */

const repoRoot = join(__dirname, '../..');

/** app -> linkedom -> htmlparser2 -> entities@4 (nested), while the app's other dependency wants entities@5. */
const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0', dependencies: { linkedom: '1.0.0', other: '1.0.0' }, devDependencies: { tool: '1.0.0' } },
    'node_modules/linkedom': { version: '1.0.0', dependencies: { htmlparser2: '^2.0.0' } },
    'node_modules/htmlparser2': { version: '2.0.0', dependencies: { entities: '^4.0.0' } },
    'node_modules/htmlparser2/node_modules/entities': { version: '4.0.0' },
    'node_modules/other': { version: '1.0.0', dependencies: { entities: '^5.0.0' }, optionalDependencies: { 'native-darwin': '1.0.0' } },
    'node_modules/entities': { version: '5.0.0' },
    'node_modules/native-darwin': { version: '1.0.0', optional: true },
    'node_modules/tool': { version: '1.0.0', dev: true, dependencies: { entities: '^5.0.0' } },
  },
});

const LOCKED_PATHS = [
  'node_modules/entities',
  'node_modules/htmlparser2',
  'node_modules/htmlparser2/node_modules/entities',
  'node_modules/linkedom',
  'node_modules/other',
];

type Tree = Record<string, string>;

function writeTree(base: string, files: Tree): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), contents);
  }
}

const manifest = (name: string, version: string): string => JSON.stringify({ name, version });

/** A real install laid out exactly as the lockfile says. */
const INSTALL: Tree = {
  'node_modules/linkedom/package.json': manifest('linkedom', '1.0.0'),
  'node_modules/htmlparser2/package.json': manifest('htmlparser2', '2.0.0'),
  'node_modules/htmlparser2/node_modules/entities/package.json': manifest('entities', '4.0.0'),
  'node_modules/other/package.json': manifest('other', '1.0.0'),
  'node_modules/entities/package.json': manifest('entities', '5.0.0'),
};

/** electron-builder re-hoists: entities@4 moves to the top and entities@5 nests under its dependent. */
const PACKAGED: Tree = {
  'package.json': manifest('fixture', '1.0.0'),
  'node_modules/linkedom/package.json': manifest('linkedom', '1.0.0'),
  'node_modules/htmlparser2/package.json': manifest('htmlparser2', '2.0.0'),
  'node_modules/entities/package.json': manifest('entities', '4.0.0'),
  'node_modules/other/package.json': manifest('other', '1.0.0'),
  'node_modules/other/node_modules/entities/package.json': manifest('entities', '5.0.0'),
};

type AsarNode = { files?: Record<string, AsarNode>; size?: number; offset?: string; unpacked?: boolean };

/** Minimal asar writer (the format @electron/asar produces): size pickle, header pickle, then file data. */
function writeAsar(asarPath: string, files: Tree, unpacked: readonly string[] = []): void {
  const root: AsarNode = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      node.files ??= {};
      node = node.files[segment] ??= { files: {} };
    }
    const data = Buffer.from(contents);
    node.files ??= {};
    if (unpacked.includes(path)) {
      node.files[segments.at(-1) ?? ''] = { size: data.length, unpacked: true };
      writeTree(`${asarPath}.unpacked`, { [path]: contents });
    } else {
      node.files[segments.at(-1) ?? ''] = { size: data.length, offset: String(offset) };
      chunks.push(data);
      offset += data.length;
    }
  }
  const json = Buffer.from(JSON.stringify(root));
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  mkdirSync(dirname(asarPath), { recursive: true });
  writeFileSync(asarPath, Buffer.concat([size, header, ...chunks]));
}

const without = (tree: Tree, prefix: string): Tree => Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith(prefix)));

describe('locked production dependencies', () => {
  it('requires production packages only, skipping dev and optional entries', () => {
    expect(requiredProductionPackages(LOCK)).toEqual(LOCKED_PATHS);
  });

  it('follows Node lookup order from nested packages', () => {
    expect(lookupCandidates('', 'a')).toEqual(['node_modules/a']);
    expect(lookupCandidates('node_modules/@s/x/node_modules/y', '@t/z')).toEqual([
      'node_modules/@s/x/node_modules/y/node_modules/@t/z',
      'node_modules/@s/x/node_modules/@t/z',
      'node_modules/@t/z',
    ]);
  });

  it('records each dependency edge with the version the lockfile resolves it to', () => {
    expect(productionDependencyEdges(LOCK)).toEqual([
      { from: '', name: 'linkedom', version: '1.0.0' },
      { from: '', name: 'other', version: '1.0.0' },
      { from: 'node_modules/linkedom', name: 'htmlparser2', version: '2.0.0' },
      { from: 'node_modules/htmlparser2', name: 'entities', version: '4.0.0' },
      { from: 'node_modules/other', name: 'entities', version: '5.0.0' },
    ]);
  });

  it('covers linkedom -> htmlparser2 in the real lockfile', () => {
    const edges = productionDependencyEdges(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'node_modules/linkedom', name: 'htmlparser2' }));
  });
});

describe('production dependency checks', () => {
  let base = '';
  let root = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'interleaf-package-deps-'));
    root = join(base, 'worktree');
    writeTree(root, { 'package-lock.json': LOCK });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('local install', () => {
    it('accepts a complete local install', () => {
      writeTree(root, INSTALL);
      expect(localDependencyProblems(root)).toEqual([]);
    });

    it('rejects a missing node_modules', () => {
      expect(localDependencyProblems(root).join('\n')).toMatch(/does not exist; run `npm ci` in this worktree/);
    });

    it('rejects a symlinked node_modules even when the target is complete', () => {
      const primary = join(base, 'primary');
      writeTree(primary, INSTALL);
      symlinkSync(join(primary, 'node_modules'), join(root, 'node_modules'));
      const problems = localDependencyProblems(root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/node_modules is a symlink/);
      expect(problems[0]).toMatch(/run `npm ci` in this worktree/);
    });

    it('rejects a package missing from the install or linked in from outside it', () => {
      writeTree(root, without(INSTALL, 'node_modules/htmlparser2/'));
      expect(localDependencyProblems(root).join('\n')).toMatch(/node_modules\/htmlparser2 is not installed/);
      writeTree(join(base, 'elsewhere'), { 'htmlparser2/package.json': manifest('htmlparser2', '2.0.0') });
      symlinkSync(join(base, 'elsewhere', 'htmlparser2'), join(root, 'node_modules', 'htmlparser2'));
      expect(localDependencyProblems(root).join('\n')).toMatch(/node_modules\/htmlparser2 resolves outside this worktree's node_modules/);
    });
  });

  describe('packaged app', () => {
    const app = (): string => join(root, 'release', 'mac-arm64', 'Interleaf.app');
    const asar = (): string => join(app(), 'Contents', 'Resources', 'app.asar');

    it('accepts a re-hoisted asar in which every locked edge resolves to its locked version', () => {
      writeAsar(asar(), PACKAGED, ['node_modules/other/node_modules/entities/package.json']);
      expect(new AsarArchive(asar()).packageVersion('node_modules/other/node_modules/entities')).toBe('5.0.0');
      expect(packagedDependencyProblems(app(), root)).toEqual([]);
    });

    it('rejects the observed defect: linkedom packaged without htmlparser2', () => {
      writeAsar(asar(), without(PACKAGED, 'node_modules/htmlparser2/'));
      const problems = packagedDependencyProblems(app(), root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('htmlparser2 cannot be resolved from node_modules/linkedom');
      expect(problems[0]).toContain('htmlparser2@2.0.0 is not packaged');
      expect(problems[0]).toMatch(/run `npm ci` in this worktree/);
    });

    it('rejects a dependency that resolves to a different version than the lockfile', () => {
      writeAsar(asar(), without(PACKAGED, 'node_modules/other/node_modules/'));
      expect(packagedDependencyProblems(app(), root).join('\n')).toContain('node_modules/other resolves entities@4.0.0, not 5.0.0');
    });

    it('rejects a missing archive', () => {
      expect(packagedDependencyProblems(app(), root)).toEqual([`${asar()} was not produced`]);
    });

    it('fails the release before its build and before its DMG submission', () => {
      const primary = join(base, 'primary');
      writeTree(primary, INSTALL);
      symlinkSync(join(primary, 'node_modules'), join(root, 'node_modules'));
      const inputs = macReleaseBuildInputProblems(root, { APPLE_KEYCHAIN_PROFILE: 'release-notary', INTERLEAF_MAC_SIGNING_IDENTITY: 'Jane Doe (ABCDE12345)' }, 'darwin');
      expect(inputs.join('\n')).toMatch(/node_modules is a symlink.*run `npm ci` in this worktree/);

      writeAsar(asar(), without(PACKAGED, 'node_modules/htmlparser2/'));
      const signed = (file: string, args: readonly string[]): ToolResult => {
        if (args[0] === '-dvv') {
          const details = ['CodeDirectory v=20500 flags=0x10000(runtime)', 'Authority=Developer ID Application: Jane Doe (ABCDE12345)', 'TeamIdentifier=ABCDE12345'];
          return { status: 0, stdout: '', stderr: details.join('\n') };
        }
        return { status: 0, stdout: file.endsWith('lipo') ? 'arm64\n' : '', stderr: '' };
      };
      const problems = macReleaseAppProblems(root, 'arm64', 0, { identity: 'Jane Doe (ABCDE12345)', teamId: 'ABCDE12345' }, signed);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('htmlparser2 cannot be resolved from node_modules/linkedom');
    });
  });
});
