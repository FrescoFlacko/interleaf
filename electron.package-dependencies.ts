import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production dependency completeness for packaged builds.
 *
 * electron-builder 26.15.3 collects production dependencies from the project's
 * `node_modules`. When that tree is not a real local install (for example a
 * worktree whose `node_modules` is a symlink to another checkout), it logs
 * `cannot find path for dependency` and still packages, signs and notarizes an
 * app whose asar lacks those modules. The 0.2.0 arm64 DMG shipped without
 * `htmlparser2` that way and failed at startup inside linkedom.
 *
 * `package-lock.json` is the source of truth, checked twice:
 *
 * - before anything is built, every production package path in the lockfile
 *   must be installed inside this checkout's own, non-symlinked `node_modules`;
 * - after packaging, every production dependency edge in the lockfile
 *   (`a@1 -> b@2`) must hold inside the app's asar under Node's lookup rules.
 *   electron-builder re-hoists the tree, so packaged paths differ from the
 *   lockfile's; the check follows resolution rather than paths.
 *
 * Dev-only and optional entries (platform prebuilds such as `@img/sharp-*`)
 * are not required: only the host's optional variants are ever installed.
 */

type Dependencies = Readonly<Record<string, string>>;
type LockPackage = {
  readonly version?: string;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly dependencies?: Dependencies;
  readonly peerDependencies?: Dependencies;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
};
type Lockfile = { readonly packages?: Readonly<Record<string, LockPackage>> };

/** A lockfile requirement: the package at `from` (`''` is the app) must resolve `name` to `version`. */
export type DependencyEdge = { readonly from: string; readonly name: string; readonly version: string };

const NPM_CI_HINT = 'run `npm ci` in this worktree so node_modules is a real local install, then retry';
const NODE_MODULES = 'node_modules/';
const LISTED = 10;

const parseLock = (lockText: string): Readonly<Record<string, LockPackage>> => (JSON.parse(lockText) as Lockfile).packages ?? {};
const isRequired = (entry: LockPackage): boolean => entry.dev !== true && entry.optional !== true && entry.devOptional !== true;
const packageName = (path: string): string => path.slice(path.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
const identity = (path: string, version: string | undefined): string => `${path === '' ? 'the app' : packageName(path)}@${version ?? '?'}`;

function listed(items: readonly string[], separator: string): string {
  const more = items.length > LISTED ? `${separator}+${String(items.length - LISTED)} more` : '';
  return `${items.slice(0, LISTED).join(separator)}${more}`;
}

/** Lockfile install paths (`node_modules/a/node_modules/b`) that a production install must contain. */
export function requiredProductionPackages(lockText: string): string[] {
  return Object.entries(parseLock(lockText))
    .filter(([path, entry]) => path.startsWith(NODE_MODULES) && isRequired(entry))
    .map(([path]) => path)
    .sort();
}

/**
 * Node's lookup candidates for `name` required from the package directory `from`:
 * `from/node_modules/name`, then each enclosing package's `node_modules`, then the root's.
 */
export function lookupCandidates(from: string, name: string): string[] {
  const owners = from === '' ? [] : from.slice(NODE_MODULES.length).split(`/${NODE_MODULES}`);
  const candidates: string[] = [];
  for (let depth = owners.length; depth >= 0; depth -= 1) {
    candidates.push(`${NODE_MODULES}${[...owners.slice(0, depth), name].join(`/${NODE_MODULES}`)}`);
  }
  return candidates;
}

function declaredDependencies(entry: LockPackage): string[] {
  const peers = Object.keys(entry.peerDependencies ?? {}).filter((name) => entry.peerDependenciesMeta?.[name]?.optional !== true);
  return [...Object.keys(entry.dependencies ?? {}), ...peers];
}

/** Every dependency edge from the app or a production package to an installed, required package. */
export function productionDependencyEdges(lockText: string): DependencyEdge[] {
  const packages = parseLock(lockText);
  const edges: DependencyEdge[] = [];
  for (const [from, entry] of Object.entries(packages)) {
    if (from !== '' && !(from.startsWith(NODE_MODULES) && isRequired(entry))) continue;
    for (const name of declaredDependencies(entry)) {
      const target = lookupCandidates(from, name).find((candidate) => packages[candidate] !== undefined);
      const resolved = target === undefined ? undefined : packages[target];
      if (resolved?.version !== undefined && isRequired(resolved)) {
        edges.push({ from, name, version: resolved.version });
      }
    }
  }
  return edges;
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** A required package directory that is absent or resolves outside the project's own node_modules. */
function installedPackageProblem(realModules: string, root: string, path: string): string | undefined {
  const manifest = join(root, path, 'package.json');
  if (!existsSync(manifest)) {
    return `${path} is not installed`;
  }
  return isInside(realModules, realpathSync(manifest)) ? undefined : `${path} resolves outside this worktree's node_modules`;
}

/** Refuses a missing, symlinked or incomplete production install before anything is built or signed. */
export function localDependencyProblems(root: string): string[] {
  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) {
    return [`${modules} does not exist; ${NPM_CI_HINT}.`];
  }
  if (lstatSync(modules).isSymbolicLink()) {
    return [`${modules} is a symlink; electron-builder omits dependencies it cannot resolve through it. Remove the link and ${NPM_CI_HINT}.`];
  }
  const realModules = realpathSync(modules);
  const required = requiredProductionPackages(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const missing = required.flatMap((path) => installedPackageProblem(realModules, root, path) ?? []);
  return missing.length === 0 ? [] : [`production dependencies do not match package-lock.json (${listed(missing, '; ')}); ${NPM_CI_HINT}.`];
}

type AsarEntry = {
  readonly files?: Readonly<Record<string, AsarEntry>>;
  readonly size?: number;
  readonly offset?: string;
  readonly unpacked?: boolean;
};

/**
 * Read-only view of an asar archive: a pickled uint32 header size at byte 4,
 * then at byte 8 a pickle whose int32 at offset 4 is the JSON header length and
 * whose JSON starts at offset 8. File data follows the header; unpacked files
 * stay listed in the header and live beside the archive in `app.asar.unpacked`.
 */
export class AsarArchive {
  private readonly asarPath: string;
  private readonly header: AsarEntry;
  private readonly dataStart: number;

  constructor(asarPath: string) {
    this.asarPath = asarPath;
    const fd = openSync(asarPath, 'r');
    try {
      const sizePickle = Buffer.alloc(8);
      readSync(fd, sizePickle, 0, 8, 0);
      const header = Buffer.alloc(sizePickle.readUInt32LE(4));
      readSync(fd, header, 0, header.length, 8);
      this.header = JSON.parse(header.toString('utf8', 8, 8 + header.readInt32LE(4))) as AsarEntry;
      this.dataStart = 8 + header.length;
    } finally {
      closeSync(fd);
    }
  }

  private entry(path: string): AsarEntry | undefined {
    let entry: AsarEntry | undefined = this.header;
    for (const segment of path.split('/')) {
      entry = entry?.files?.[segment];
    }
    return entry;
  }

  /** Contents of a regular file in the archive, or undefined when it is absent. */
  readFile(path: string): Buffer | undefined {
    const entry = this.entry(path);
    if (entry === undefined || entry.files !== undefined || entry.size === undefined) {
      return undefined;
    }
    if (entry.unpacked === true) {
      return readFileSync(join(`${this.asarPath}.unpacked`, path));
    }
    const data = Buffer.alloc(entry.size);
    const fd = openSync(this.asarPath, 'r');
    try {
      readSync(fd, data, 0, entry.size, this.dataStart + Number(entry.offset));
    } finally {
      closeSync(fd);
    }
    return data;
  }

  /** Every `node_modules/.../<name>` package directory with a package.json, at any depth. */
  packageDirectories(): string[] {
    const found: string[] = [];
    const visit = (entry: AsarEntry | undefined, prefix: string): void => {
      for (const [name, child] of Object.entries(entry?.files ?? {})) {
        const path = `${prefix}${name}`;
        if (name.startsWith('@')) {
          visit(child, `${path}/`);
        } else if (child.files?.['package.json'] !== undefined) {
          found.push(path);
          visit(child.files[NODE_MODULES.slice(0, -1)], `${path}/${NODE_MODULES}`);
        }
      }
    };
    visit(this.entry(NODE_MODULES.slice(0, -1)), NODE_MODULES);
    return found;
  }

  packageVersion(path: string): string | undefined {
    const manifest = this.readFile(path === '' ? 'package.json' : `${path}/package.json`);
    return manifest === undefined ? undefined : (JSON.parse(manifest.toString('utf8')) as { version?: string }).version;
  }
}

/** Where each lockfile source package (by name@version) was placed in the archive. */
function packagedInstances(archive: AsarArchive): Map<string, string[]> {
  const instances = new Map<string, string[]>([[identity('', undefined), ['']]]);
  for (const path of archive.packageDirectories()) {
    const key = identity(path, archive.packageVersion(path));
    instances.set(key, [...(instances.get(key) ?? []), path]);
  }
  return instances;
}

function edgeProblems(archive: AsarArchive, instances: Map<string, string[]>, versions: Map<string, string | undefined>, edge: DependencyEdge): string[] {
  const source = edge.from === '' ? identity('', undefined) : identity(edge.from, versions.get(edge.from));
  const placed = instances.get(source) ?? [];
  if (placed.length === 0) {
    return [`${source} is not packaged`];
  }
  return placed.flatMap((from) => {
    const target = lookupCandidates(from, edge.name).find((candidate) => archive.packageVersion(candidate) !== undefined);
    const found = target === undefined ? undefined : archive.packageVersion(target);
    if (found === edge.version) return [];
    const where = from === '' ? 'the app' : from;
    return [found === undefined ? `${edge.name} cannot be resolved from ${where}` : `${where} resolves ${edge.name}@${found}, not ${edge.version}`];
  });
}

/** Every production dependency edge in package-lock.json must resolve to the locked version inside the app's asar. */
export function packagedDependencyProblems(appPath: string, root: string): string[] {
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(asarPath)) {
    return [`${asarPath} was not produced`];
  }
  const lockText = readFileSync(join(root, 'package-lock.json'), 'utf8');
  const versions = new Map(Object.entries(parseLock(lockText)).map(([path, entry]) => [path, entry.version]));
  const archive = new AsarArchive(asarPath);
  const instances = packagedInstances(archive);
  const problems = [...new Set(productionDependencyEdges(lockText).flatMap((edge) => edgeProblems(archive, instances, versions, edge)))];
  return problems.length === 0 ? [] : [`${appPath}: app.asar has incomplete production dependencies (${listed(problems, '; ')}); ${NPM_CI_HINT}.`];
}

/** `node electron.package-dependencies.ts <path/to/Interleaf.app>`: checks an unsigned or signed package. */
function main(): void {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const appPath = process.argv[2];
  if (appPath === undefined || process.argv.length !== 3) {
    console.error('Usage: node electron.package-dependencies.ts <path/to/Interleaf.app>');
    process.exit(2);
  }
  const problems = [...localDependencyProblems(root), ...packagedDependencyProblems(resolve(appPath), root)];
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  const edges = productionDependencyEdges(readFileSync(join(root, 'package-lock.json'), 'utf8')).length;
  console.log(`${appPath}: all ${String(edges)} locked production dependency edges resolve inside app.asar.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
