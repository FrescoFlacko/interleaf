/**
 * Builds the static Interleaf marketing site from `website/` into `out/website`.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON website.build.ts [--out <directory>]
 *
 * The output is plain static files — HTML, CSS, one script, images and a
 * Cloudflare `_headers` file — suitable for any static host or a Workers
 * static-assets deployment. Nothing secret is read or written.
 *
 * The macOS download buttons ship as unavailable `<button aria-disabled>`
 * controls. Setting a URL in `website/site.config.json` turns the matching
 * control into a real link at build time; a URL that is not an `https://`
 * link to a `.dmg` file fails the build instead of being published.
 */
import { copyFile, lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import type { PortableMember, PortableRecord, PortableValue } from './src/shared/models/portable';

export type DownloadKey = 'macos-arm64' | 'macos-x64';
export const DOWNLOAD_KEYS: readonly DownloadKey[] = ['macos-arm64', 'macos-x64'];

export type SiteConfig = {
  readonly downloads: Readonly<Record<DownloadKey, string | null>>;
};

export type BuildOptions = {
  readonly projectRoot: string;
  readonly outDir: string;
  /** Overrides `website/site.config.json`; used by tests. */
  readonly config?: SiteConfig;
  /** Tests skip the Vite bundle, which is slow and has no bearing on the HTML. */
  readonly bundleClient?: boolean;
};

export type BuildResult = {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly wiredDownloads: readonly DownloadKey[];
};

/** Content Security Policy for the published site: same-origin files only. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/* Download links ------------------------------------------------------------ */

/**
 * Accepts only a plain `https://` URL whose path ends in `.dmg`, with no
 * embedded credentials. Returns the normalised URL, or throws with the reason.
 */
export function validateDownloadUrl(key: string, value: PortableMember): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`downloads.${key} must be null or an https:// URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`downloads.${key} is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`downloads.${key} must use https://`);
  if (url.username !== '' || url.password !== '') {
    throw new Error(`downloads.${key} must not contain credentials`);
  }
  if (!url.pathname.toLowerCase().endsWith('.dmg')) {
    throw new Error(`downloads.${key} must point at a .dmg file`);
  }
  return url.href;
}

export function parseSiteConfig(value: PortableValue): SiteConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('site.config.json must be an object');
  const { downloads } = value as PortableRecord;
  if (typeof downloads !== 'object' || downloads === null || Array.isArray(downloads)) throw new Error('site.config.json needs a downloads object');
  const entries = downloads as PortableRecord;
  for (const key of Object.keys(entries)) {
    if (!(DOWNLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown download key: ${key}`);
  }
  const parsed = {} as Record<DownloadKey, string | null>;
  for (const key of DOWNLOAD_KEYS) {
    if (!(key in entries)) throw new Error(`downloads.${key} is missing; use null while there is no URL`);
    parsed[key] = validateDownloadUrl(key, entries[key]);
  }
  return { downloads: parsed };
}

/**
 * Wires each `[data-download]` control whose key has a URL into a real link
 * and updates the status notes that describe it. Unconfigured controls stay
 * as the unavailable buttons written in the source HTML.
 */
export function applyDownloads(document: Document, config: SiteConfig): readonly DownloadKey[] {
  const controls = [...document.querySelectorAll('[data-download]')];
  if (controls.length === 0) throw new Error('index.html has no [data-download] controls');
  const wired = new Set<DownloadKey>();
  const statusWiring = new Map<string, boolean[]>();

  for (const control of controls) {
    const key = control.getAttribute('data-download') ?? '';
    if (!(DOWNLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown data-download key: ${key}`);
    const url = config.downloads[key as DownloadKey];
    const describedBy = control.getAttribute('aria-describedby');
    if (describedBy !== null) statusWiring.set(describedBy, [...(statusWiring.get(describedBy) ?? []), url !== null]);
    if (url === null) continue;

    const link = document.createElement('a');
    for (const name of ['class', 'data-download']) {
      const attribute = control.getAttribute(name);
      if (attribute !== null) link.setAttribute(name, attribute);
    }
    link.setAttribute('href', url);
    link.append(...control.childNodes);
    control.replaceWith(link);
    wired.add(key as DownloadKey);
  }

  for (const [id, states] of statusWiring) {
    const note = document.getElementById(id);
    if (note === null) throw new Error(`Missing download status note #${id}`);
    if (states.every(Boolean)) {
      note.innerHTML = '<span class="status-note__pill">Beta</span> A pre-release build for macOS. Expect rough edges.';
    } else if (states.some(Boolean)) {
      note.innerHTML = '<span class="status-note__pill">Coming soon</span> Not every build is available yet.';
    }
  }
  return [...wired];
}

/* Assets -------------------------------------------------------------------- */

const LOCAL_ASSET = /^assets\/(?:screens|brand)\/[a-z0-9-]+\.(?:webp|png)$/u;

/** Every local image the page references, from `src`, `srcset` and `href`. */
export function referencedAssets(document: Document): readonly string[] {
  const found = new Set<string>();
  for (const element of document.querySelectorAll('[src], [srcset], [href]')) {
    const candidates = [element.getAttribute('src'), element.getAttribute('href')];
    for (const part of (element.getAttribute('srcset') ?? '').split(',')) {
      candidates.push(part.trim().split(/\s+/u)[0] ?? null);
    }
    for (const candidate of candidates) {
      if (candidate?.startsWith('assets/') !== true) continue;
      if (candidate === 'assets/site.js') continue;
      if (!LOCAL_ASSET.test(candidate)) throw new Error(`Unexpected asset reference: ${candidate}`);
      found.add(candidate);
    }
  }
  return [...found].sort();
}

export function renderPage(sourceHtml: string, config: SiteConfig): { html: string; assets: readonly string[]; wired: readonly DownloadKey[] } {
  const { document } = parseHTML(sourceHtml);
  const wired = applyDownloads(document, config);
  // The same policy as `_headers`, for hosts that cannot send headers.
  const csp = document.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', CONTENT_SECURITY_POLICY);
  document.head.prepend(csp);
  const charset = document.querySelector('meta[charset]');
  if (charset !== null) document.head.prepend(charset);
  const assets = referencedAssets(document);
  return { html: `<!doctype html>\n${document.documentElement.outerHTML}\n`, assets, wired };
}

export function headersFile(): string {
  return [
    '/*',
    `  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '/assets/*',
    '  Cache-Control: public, max-age=86400',
    '',
  ].join('\n');
}

/* Output directory safety ----------------------------------------------------
 * The same rules as the wiki generator: the output directory is only reused
 * when it carries this generator's marker, and then only the files that
 * marker lists are removed. Protected project folders, the project root and
 * its parents, and any path through a symbolic link are refused outright.
 */

export const OUTPUT_MARKER = '.interleaf-website-build.json';
/** Keeps the marker out of a Cloudflare Workers static-assets upload. */
export const ASSETS_IGNORE = '.assetsignore';
const DOTFILES: readonly string[] = [OUTPUT_MARKER, ASSETS_IGNORE];
const MARKER_GENERATOR = 'interleaf-website';
const MARKER_VERSION = 1;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const PROTECTED_PROJECT_DIRS = [
  '.git', '.agents', '.codex', '.worktrees', 'docs', 'node_modules', 'resources', 'scripts', 'src', 'tests',
  'website', 'wiki-site',
];

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function canonicalOutputPath(target: string): Promise<string> {
  const absolute = resolve(target);
  const segments: string[] = [];
  let current = absolute;
  while (dirname(current) !== current) {
    segments.unshift(basename(current));
    current = dirname(current);
  }
  for (const segment of segments) {
    current = join(current, segment);
    if ((await statOrNull(current))?.isSymbolicLink() === true) {
      throw new Error(`Refusing to build through a symbolic link: ${current}`);
    }
  }
  return absolute;
}

function assertUnprotectedOutput(outDir: string, projectRoot: string): void {
  if (dirname(outDir) === outDir) throw new Error(`Refusing to build into a filesystem root: ${outDir}`);
  if (isSameOrInside(outDir, projectRoot)) {
    throw new Error(`Refusing to build into the project root or one of its parents: ${outDir}`);
  }
  for (const name of PROTECTED_PROJECT_DIRS) {
    const directory = join(projectRoot, name);
    if (isSameOrInside(outDir, directory) || isSameOrInside(directory, outDir)) {
      throw new Error(`Refusing to build into a protected project directory: ${outDir}`);
    }
  }
}

async function readMarkerFiles(outDir: string): Promise<readonly string[] | null> {
  const file = join(outDir, OUTPUT_MARKER);
  const info = await statOrNull(file);
  if (info === null) return null;
  if (!info.isFile()) throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} is not a regular file`);
  let parsed: PortableValue;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as PortableValue;
  } catch {
    throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} is not valid JSON`);
  }
  const { generator, version, files } = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as PortableRecord;
  const valid = generator === MARKER_GENERATOR && version === MARKER_VERSION && Array.isArray(files)
    && (files as readonly PortableValue[]).every((entry) => typeof entry === 'string' && (DOTFILES.includes(entry) || SAFE_RELATIVE_PATH.test(entry)));
  if (!valid) throw new Error(`Refusing to reuse ${outDir}: ${OUTPUT_MARKER} was not written by this generator`);
  return files as readonly string[];
}

/** Resolves one output path, refusing links, non-files and escapes. */
async function resolveOutputFile(outDir: string, relativePath: string): Promise<{ path: string; exists: boolean }> {
  if (!DOTFILES.includes(relativePath) && !SAFE_RELATIVE_PATH.test(relativePath)) {
    throw new Error(`Refusing to use an unsafe output path: ${relativePath}`);
  }
  const segments = relativePath.split('/');
  let directory = outDir;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    const info = await statOrNull(directory);
    if (info === null) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to use ${directory}: it is not a plain directory`);
    }
  }
  const path = join(outDir, ...segments);
  if (path === outDir || !isSameOrInside(outDir, path)) throw new Error(`Refusing to use a path outside the output directory: ${path}`);
  const info = await statOrNull(path);
  if (info === null) return { path, exists: false };
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to use ${path}: it is not a regular file`);
  return { path, exists: true };
}

/**
 * Validates the output directory and clears exactly this generator's previous
 * files from it. Every path is checked before anything is deleted.
 */
export async function prepareOutputDirectory(target: string, projectRoot: string, writes: readonly string[] = []): Promise<string> {
  const outDir = await canonicalOutputPath(target);
  assertUnprotectedOutput(outDir, resolve(projectRoot));
  const info = await statOrNull(outDir);
  if (info !== null && !info.isDirectory()) throw new Error(`Refusing to build into ${outDir}: it is not a directory`);
  const owned = info === null ? null : await readMarkerFiles(outDir);
  if (info !== null && owned === null && (await readdir(outDir)).length > 0) {
    throw new Error(`Refusing to build into ${outDir}: it is not empty and was not written by this generator`);
  }
  const ownedSet = new Set(owned === null ? [] : [...owned, OUTPUT_MARKER]);
  const remove: string[] = [];
  for (const entry of ownedSet) {
    const file = await resolveOutputFile(outDir, entry);
    if (file.exists) remove.push(file.path);
  }
  for (const entry of writes) {
    const file = await resolveOutputFile(outDir, entry);
    if (file.exists && !ownedSet.has(entry)) throw new Error(`Refusing to overwrite ${file.path}: this generator did not write it`);
  }
  if (info === null) await mkdir(outDir, { recursive: true });

  const directories = new Set<string>();
  for (const file of remove) {
    const current = await statOrNull(file);
    if (current === null || current.isSymbolicLink() || !current.isFile()) continue;
    await unlink(file);
    for (let parent = dirname(file); parent !== outDir && isSameOrInside(outDir, parent); parent = dirname(parent)) {
      directories.add(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch {
      // Left in place when something else lives there.
    }
  }
  return outDir;
}

async function ensureDirectory(outDir: string, directory: string): Promise<void> {
  let current = outDir;
  for (const segment of relative(outDir, directory).split(sep).filter((part) => part !== '')) {
    current = join(current, segment);
    const info = await statOrNull(current);
    if (info === null) {
      await mkdir(current);
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to write through ${current}: it is not a plain directory`);
    }
  }
}

async function writeOutput(outDir: string, relativePath: string, contents: string | { copyFrom: string }): Promise<void> {
  const { path } = await resolveOutputFile(outDir, relativePath);
  await ensureDirectory(outDir, dirname(path));
  if (typeof contents === 'string') await writeFile(path, contents, 'utf8');
  else await copyFile(contents.copyFrom, path);
}

async function bundleClient(projectRoot: string, outDir: string): Promise<void> {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: projectRoot,
    publicDir: false,
    build: {
      outDir: join(outDir, 'assets'),
      emptyOutDir: false,
      target: 'es2020',
      lib: {
        entry: join(projectRoot, 'website.client.ts'),
        formats: ['iife'],
        name: 'InterleafSite',
        fileName: () => 'site.js',
      },
    },
  });
}

/* Build --------------------------------------------------------------------- */

export async function readSiteConfig(projectRoot: string): Promise<SiteConfig> {
  return parseSiteConfig(JSON.parse(await readFile(join(projectRoot, 'website', 'site.config.json'), 'utf8')) as PortableValue);
}

export async function buildWebsite(options: BuildOptions): Promise<BuildResult> {
  const source = join(options.projectRoot, 'website');
  const config = options.config ?? (await readSiteConfig(options.projectRoot));
  const page = renderPage(await readFile(join(source, 'index.html'), 'utf8'), config);
  for (const asset of page.assets) {
    const info = await statOrNull(join(source, asset));
    if (info?.isFile() !== true) throw new Error(`index.html references a missing image: ${asset}`);
  }

  const bundle = options.bundleClient !== false;
  const files = ['index.html', 'styles.css', '_headers', ASSETS_IGNORE, ...page.assets, ...(bundle ? ['assets/site.js'] : [])];
  const outDir = await prepareOutputDirectory(options.outDir, options.projectRoot, [...files, OUTPUT_MARKER]);

  await writeOutput(outDir, 'index.html', page.html);
  await writeOutput(outDir, 'styles.css', await readFile(join(source, 'styles.css'), 'utf8'));
  await writeOutput(outDir, '_headers', headersFile());
  await writeOutput(outDir, ASSETS_IGNORE, `${OUTPUT_MARKER}\n`);
  for (const asset of page.assets) await writeOutput(outDir, asset, { copyFrom: join(source, asset) });
  if (bundle) {
    await ensureDirectory(outDir, join(outDir, 'assets'));
    await bundleClient(options.projectRoot, outDir);
  }
  // Written last: it states exactly what a later build may remove.
  const marker = { generator: MARKER_GENERATOR, version: MARKER_VERSION, generatedAt: new Date().toISOString(), files };
  await writeOutput(outDir, OUTPUT_MARKER, `${JSON.stringify(marker, null, 2)}\n`);
  return { outDir, files, wiredDownloads: page.wired };
}

export function outDirFromArgv(argv: readonly string[], projectRoot: string): string {
  const flag = argv.indexOf('--out');
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined || value === '') return join(projectRoot, 'out', 'website');
  return resolve(projectRoot, value);
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const result = await buildWebsite({ projectRoot, outDir: outDirFromArgv(process.argv.slice(2), projectRoot) });
  const inside = relative(projectRoot, result.outDir);
  const where = inside.startsWith('..') ? result.outDir : `.${sep}${inside}`;
  const downloads = result.wiredDownloads.length === 0 ? 'none wired (coming soon)' : result.wiredDownloads.join(', ');
  process.stdout.write(`Interleaf website: ${String(result.files.length)} files written to ${where}; downloads: ${downloads}\n`);
  process.stdout.write(`Preview with: python3 -m http.server --directory ${where} 4174\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
