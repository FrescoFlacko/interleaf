import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as PackageDependencies from './electron.package-dependencies';
import type { PortableRecord, PortableValue } from './src/shared/models/portable';

/**
 * Node runs this file with type stripping, which needs the `.ts` extension on a
 * relative import; the TypeScript config rejects that extension in a static
 * specifier, so the sibling module is loaded dynamically and typed statically.
 */
const packageDependenciesModule = './electron.package-dependencies.ts';
const { localDependencyProblems, packagedDependencyProblems } = (await import(packageDependenciesModule)) as typeof PackageDependencies;

/**
 * Fail-closed macOS release packaging: a notarized, stapled DMG per arch, plus
 * the update ZIP (and its blockmap) electron-updater installs from.
 *
 * The checked-in `electron-builder.yml` stays usable for unsigned structure
 * builds, so on its own it cannot tell a release from a smoke package. With
 * electron-builder 26.15.3:
 *
 * - a missing signing identity only logs "skipped macOS application code
 *   signing" unless `forceCodeSigning` is set;
 * - `mac.notarize: true` without Apple credentials in the environment only logs
 *   "skipped macOS notarization";
 * - signing is silently skipped on a pull-request CI build;
 * - `--mac --arm64` without target names still builds every target *and every
 *   arch* listed in the config (targetFactory.computeArchToTargetNamesMap), so
 *   the release names the `dmg` and `zip` targets explicitly to build only what
 *   it checks;
 * - built-in notarization covers the `.app` only, never the DMG around it.
 *
 * - production dependencies it cannot resolve (for example through a symlinked
 *   `node_modules`) are only logged as `cannot find path for dependency`, and
 *   the app is still packaged, signed and notarized without them.
 *
 * This command therefore refuses to start without the notary profile or with a
 * production install that does not match package-lock.json, pins the
 * Developer ID identity named by INTERLEAF_MAC_SIGNING_IDENTITY, `forceCodeSigning` and a locale-data `signIgnore` for this invocation only, checks
 * each built app (Developer ID signature, hardened runtime, stapled ticket,
 * arch, and every locked production dependency resolving inside its asar), then requires each freshly built DMG container to carry the same
 * Developer ID signature (applied through a release-only `dmg.sign` override),
 * submits it to the Notary Service through the same keychain profile, waits
 * for `Accepted`, staples it and requires stapler and Gatekeeper to accept it.
 * Each update ZIP must carry a fresh blockmap and, once extracted, the same
 * Developer ID, hardened-runtime, single-arch and stapled app; Squirrel.Mac
 * later refuses any bundle whose signature does not satisfy the running app's
 * designated requirement. Only then does it report success. It never reads
 * or prints credential values: only variable names and the profile name.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The Developer ID signer. `identity` is the keychain identity name without the
 * "Developer ID Application:" prefix, which electron-builder rejects, for
 * example `Jane Doe (ABCDE12345)`; `teamId` is its parenthesized suffix.
 */
export type MacReleaseSigner = { readonly identity: string; readonly teamId: string };

export const MAC_SIGNING_IDENTITY_VARIABLE = 'INTERLEAF_MAC_SIGNING_IDENTITY';
const SIGNING_IDENTITY_PATTERN = /^(?!Developer ID)[^\p{Cc}\p{Zl}\p{Zp}()]+ \([A-Z0-9]{10}\)$/u;

/** Reads the signer from the environment; anything but `Name (TEAMID1234)` yields none. */
export function macReleaseSigner(env: Environment): MacReleaseSigner | undefined {
  const identity = (env[MAC_SIGNING_IDENTITY_VARIABLE] ?? '').trim();
  // The pattern ends with the ten-character team identifier and a closing parenthesis.
  return SIGNING_IDENTITY_PATTERN.test(identity) ? { identity, teamId: identity.slice(-11, -1) } : undefined;
}

export const macReleaseAuthority = (signer: MacReleaseSigner): string => `Developer ID Application: ${signer.identity}`;

/** Mirrors `directories.output` and `productName` in electron-builder.yml. */
const RELEASE_DIRECTORY = 'release';
const PRODUCT_NAME = 'Interleaf';

/** notarytool stops polling after this; the process deadline leaves it room to report. */
const NOTARY_WAIT = '45m';
const NOTARY_DEADLINE_MS = 50 * 60 * 1000;
const TOOL_DEADLINE_MS = 2 * 60 * 1000;

export type MacReleaseArch = 'arm64' | 'x64';
const ALL_ARCHES: readonly MacReleaseArch[] = ['arm64', 'x64'];
/** `lipo -archs` names for the main executable. */
const LIPO_ARCH: Readonly<Record<MacReleaseArch, string>> = { arm64: 'arm64', x64: 'x86_64' };

/**
 * Credentials electron-builder would prefer over `APPLE_KEYCHAIN_PROFILE`, or
 * that would move signing off the local keychain identity. Their presence makes
 * the release inputs ambiguous, so the command refuses rather than guess.
 */
const CONFLICTING_VARIABLES = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
] as const;

const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

export function macReleasePreflightProblems(env: Environment, platform: NodeJS.Platform): string[] {
  const problems: string[] = [];
  if (platform !== 'darwin') {
    problems.push('macOS release packaging must run on macOS.');
  }
  if (!isSet(env.APPLE_KEYCHAIN_PROFILE)) {
    problems.push('APPLE_KEYCHAIN_PROFILE is not set; pass the notarytool keychain profile name.');
  }
  if (macReleaseSigner(env) === undefined) {
    problems.push(
      `${MAC_SIGNING_IDENTITY_VARIABLE} is not set to a Developer ID identity name such as "Jane Doe (ABCDE12345)", without the "Developer ID Application:" prefix.`,
    );
  }
  const conflicting = CONFLICTING_VARIABLES.filter((name) => isSet(env[name]));
  if (conflicting.length > 0) {
    problems.push(`Unset ${conflicting.join(', ')}; this command signs with the keychain identity and notarizes only through APPLE_KEYCHAIN_PROFILE.`);
  }
  return [...problems, ...smokeBuildProblems(env)];
}

/** A shell set up for the packaged update smoke would inline its throwaway trust anchor into the release. */
function smokeBuildProblems(env: Environment): string[] {
  return isSet(env.INTERLEAF_UPDATE_SMOKE_TRUST) ? ['Unset INTERLEAF_UPDATE_SMOKE_TRUST; it builds a throwaway update smoke package, never a release.'] : [];
}

/** Everything that must hold before building: release inputs plus a complete, local production install. */
export function macReleaseBuildInputProblems(root: string, env: Environment, platform: NodeJS.Platform): string[] {
  return [...macReleasePreflightProblems(env, platform), ...localDependencyProblems(root)];
}

export function parseMacReleaseArches(args: readonly string[]): MacReleaseArch[] {
  const arches = new Set<MacReleaseArch>();
  for (const arg of args) {
    const arch = ALL_ARCHES.find((candidate) => arg === `--${candidate}`);
    if (arch === undefined) {
      throw new Error(`Unsupported argument ${JSON.stringify(arg)}; only --arm64 and --x64 are accepted.`);
    }
    arches.add(arch);
  }
  return arches.size === 0 ? [...ALL_ARCHES] : ALL_ARCHES.filter((arch) => arches.has(arch));
}

/**
 * Chromium locale data (`Electron Framework/Resources/<lang>.lproj/locale.pak`),
 * matched against each absolute file path. Signing each of these ~220 data files
 * individually repeatedly exhausted the timestamp service; skipped files are
 * still sealed as resources by the framework and app signatures, so strict app
 * verification and notarization still cover them.
 */
export const MAC_RELEASE_SIGN_IGNORE = '[.]lproj/locale[.]pak$';

export function electronBuilderReleaseArgs(arches: readonly MacReleaseArch[], signer: MacReleaseSigner): string[] {
  return [
    '--mac',
    'dmg',
    'zip',
    ...arches.map((arch) => `--${arch}`),
    '--publish',
    'never',
    '-c.forceCodeSigning=true',
    `-c.mac.identity=${signer.identity}`,
    '-c.mac.notarize=true',
    `-c.mac.signIgnore=${MAC_RELEASE_SIGN_IGNORE}`,
    // dmg-builder signs the container only when this is exactly true, and it
    // skips silently when no identity is found; the pre-submission check below
    // is what makes a missing container signature fatal.
    '-c.dmg.sign=true',
  ];
}

/** electron-builder names the default (x64) arch directory `mac` and others `mac-<arch>`. */
export function macReleaseAppPath(root: string, arch: MacReleaseArch): string {
  return join(root, RELEASE_DIRECTORY, arch === 'x64' ? 'mac' : `mac-${arch}`, `${PRODUCT_NAME}.app`);
}

/** dmg-builder's default `${productName}-${version}-${arch}.dmg`, with the default (x64) arch omitted. */
export function macReleaseDmgPath(root: string, version: string, arch: MacReleaseArch): string {
  return join(root, RELEASE_DIRECTORY, `${PRODUCT_NAME}-${version}${arch === 'x64' ? '' : `-${arch}`}.dmg`);
}

/** electron-builder's default `${productName}-${version}-${arch}-mac.zip`, with the default (x64) arch omitted. */
export function macReleaseZipPath(root: string, version: string, arch: MacReleaseArch): string {
  return join(root, RELEASE_DIRECTORY, `${PRODUCT_NAME}-${version}${arch === 'x64' ? '' : `-${arch}`}-mac.zip`);
}

/** Checks `codesign -dvv` output (written to stderr) for the Developer ID signer. */
export function codesignSignerProblems(details: string, signer: MacReleaseSigner): string[] {
  const lines = details.split('\n').map((line) => line.trim());
  const problems: string[] = [];
  const authority = macReleaseAuthority(signer);
  if (!lines.includes(`Authority=${authority}`)) {
    problems.push(`not signed by ${authority}`);
  }
  if (!lines.includes(`TeamIdentifier=${signer.teamId}`)) {
    problems.push(`team identifier is not ${signer.teamId}`);
  }
  return problems;
}

/** Checks `codesign -dvv` output for the app's release signature: signer plus hardened runtime. */
export function codesignDetailProblems(details: string, signer: MacReleaseSigner): string[] {
  const lines = details.split('\n').map((line) => line.trim());
  const problems = codesignSignerProblems(details, signer);
  if (!lines.some((line) => line.startsWith('CodeDirectory ') && /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(line))) {
    problems.push('hardened runtime flag is missing');
  }
  return problems;
}

export type ToolResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type ToolRunner = (file: string, args: readonly string[], timeoutMs: number) => ToolResult;

const runTool: ToolRunner = (file, args, timeoutMs) => {
  const result = spawnSync(file, args, { encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Rejects a missing artifact, or one left over from an earlier run. */
function missingOrStale(path: string, builtAfterMs: number): string | undefined {
  if (!existsSync(path)) {
    return `${path} was not produced`;
  }
  return statSync(path).mtimeMs < builtAfterMs ? `${path} predates this build` : undefined;
}

export function verifyMacReleaseApp(
  appPath: string,
  arch: MacReleaseArch,
  builtAfterMs: number,
  signer: MacReleaseSigner,
  run: ToolRunner = runTool,
): string[] {
  const absent = missingOrStale(appPath, builtAfterMs);
  if (absent !== undefined) {
    return [absent];
  }
  const problems: string[] = [];
  if (run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], TOOL_DEADLINE_MS).status !== 0) {
    problems.push('codesign --verify --deep --strict failed');
  }
  const details = run('/usr/bin/codesign', ['-dvv', appPath], TOOL_DEADLINE_MS);
  problems.push(...codesignDetailProblems(`${details.stdout}\n${details.stderr}`, signer));
  const lipo = run('/usr/bin/lipo', ['-archs', join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)], TOOL_DEADLINE_MS);
  if (lipo.status !== 0 || lipo.stdout.trim() !== LIPO_ARCH[arch]) {
    problems.push(`executable is not ${LIPO_ARCH[arch]}-only`);
  }
  if (run('/usr/bin/xcrun', ['stapler', 'validate', appPath], TOOL_DEADLINE_MS).status !== 0) {
    problems.push('no stapled notarization ticket (xcrun stapler validate failed)');
  }
  return problems.map((problem) => `${appPath}: ${problem}`);
}

/** The signed app plus its packaged production dependencies, checked before the DMG is submitted. */
export function macReleaseAppProblems(
  root: string,
  arch: MacReleaseArch,
  builtAfterMs: number,
  signer: MacReleaseSigner,
  run: ToolRunner = runTool,
): string[] {
  const appPath = macReleaseAppPath(root, arch);
  return [...verifyMacReleaseApp(appPath, arch, builtAfterMs, signer, run), ...packagedDependencyProblems(appPath, root)];
}

/**
 * The update ZIP and its blockmap must be fresh, and the app extracted from
 * the ZIP (with `ditto`, as Squirrel.Mac unpacks it) must pass the same checks
 * as the built app. The extraction directory is always removed.
 */
export function verifyMacReleaseZip(
  zipPath: string,
  arch: MacReleaseArch,
  builtAfterMs: number,
  signer: MacReleaseSigner,
  run: ToolRunner = runTool,
): string[] {
  const absent = [missingOrStale(zipPath, builtAfterMs), missingOrStale(`${zipPath}.blockmap`, builtAfterMs)].filter(
    (problem): problem is string => problem !== undefined,
  );
  if (absent.length > 0) {
    return absent;
  }
  const extracted = mkdtempSync(join(tmpdir(), 'interleaf-release-zip-'));
  try {
    if (run('/usr/bin/ditto', ['-x', '-k', zipPath, extracted], TOOL_DEADLINE_MS).status !== 0) {
      return [`${zipPath}: ditto could not extract it`];
    }
    // Extracted files keep their archived times, so freshness was checked on the ZIP itself.
    return verifyMacReleaseApp(join(extracted, `${PRODUCT_NAME}.app`), arch, 0, signer, run).map((problem) => `${zipPath}: ${problem}`);
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

export type NotarySubmission = { readonly id: string | undefined; readonly status: string | undefined };

/** Reads `notarytool submit --output-format json`; anything unparseable yields no status. */
export function parseNotarySubmission(stdout: string): NotarySubmission {
  try {
    const parsed = JSON.parse(stdout) as PortableValue;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { id: undefined, status: undefined };
    }
    const { id, status } = parsed as PortableRecord;
    return { id: typeof id === 'string' ? id : undefined, status: typeof status === 'string' ? status : undefined };
  } catch {
    return { id: undefined, status: undefined };
  }
}

/** The DMG container itself must carry the Developer ID signature before it is submitted. */
function dmgSignatureProblem(dmgPath: string, signer: MacReleaseSigner, run: ToolRunner): string | undefined {
  if (run('/usr/bin/codesign', ['--verify', '--strict', dmgPath], TOOL_DEADLINE_MS).status !== 0) {
    return 'DMG container signature is missing or invalid (codesign --verify --strict failed)';
  }
  const details = run('/usr/bin/codesign', ['-dvv', dmgPath], TOOL_DEADLINE_MS);
  const problems = codesignSignerProblems(`${details.stdout}\n${details.stderr}`, signer);
  return problems.length === 0 ? undefined : `DMG container ${problems.join('; ')}`;
}

function submitDmg(dmgPath: string, profile: string, run: ToolRunner): string | undefined {
  const result = run(
    '/usr/bin/xcrun',
    ['notarytool', 'submit', dmgPath, '--keychain-profile', profile, '--wait', '--timeout', NOTARY_WAIT, '--output-format', 'json'],
    NOTARY_DEADLINE_MS,
  );
  const { id, status } = parseNotarySubmission(result.stdout);
  if (result.status === 0 && status === 'Accepted') {
    return undefined;
  }
  const lookup = id === undefined ? '' : `; inspect with xcrun notarytool log ${id} --keychain-profile ${profile}`;
  return `notarization not accepted (status ${status ?? 'unknown'}, exit ${String(result.status)})${lookup}`;
}

/**
 * Checks the DMG container signature, then notarizes, staples and assesses it. Each step depends on the previous
 * one, so the first failure ends the sequence.
 */
export function notarizeMacReleaseDmg(
  dmgPath: string,
  profile: string,
  builtAfterMs: number,
  signer: MacReleaseSigner,
  run: ToolRunner = runTool,
): string[] {
  const steps: (() => string | undefined)[] = [
    () => missingOrStale(dmgPath, builtAfterMs),
    () => dmgSignatureProblem(dmgPath, signer, run),
    () => submitDmg(dmgPath, profile, run),
    () => (run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath], TOOL_DEADLINE_MS).status === 0 ? undefined : 'xcrun stapler staple failed'),
    () => (run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], TOOL_DEADLINE_MS).status === 0 ? undefined : 'xcrun stapler validate failed'),
    () =>
      run('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath], TOOL_DEADLINE_MS).status === 0
        ? undefined
        : 'Gatekeeper (spctl -a -t open --context context:primary-signature) rejected it',
  ];
  for (const step of steps) {
    const problem = step();
    if (problem !== undefined) {
      return [problem.startsWith(dmgPath) ? problem : `${dmgPath}: ${problem}`];
    }
  }
  return [];
}

/** The notary profile and signer, once preflight has accepted both. */
function releaseInputs(env: Environment): { readonly profile: string; readonly signer: MacReleaseSigner } | undefined {
  const profile = env.APPLE_KEYCHAIN_PROFILE;
  const signer = macReleaseSigner(env);
  return isSet(profile) && signer !== undefined ? { profile, signer } : undefined;
}

function refuse(problems: readonly string[]): never {
  console.error('Refusing to produce a macOS release:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
  let arches: MacReleaseArch[] = [];
  try {
    arches = parseMacReleaseArches(process.argv.slice(2));
  } catch (error) {
    refuse([error instanceof Error ? error.message : String(error)]);
  }
  const preflight = macReleaseBuildInputProblems(root, process.env, process.platform);
  const inputs = releaseInputs(process.env);
  if (preflight.length > 0 || inputs === undefined) {
    refuse(preflight);
  }
  const { profile, signer } = inputs;
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const bin = (name: string): string => join(root, 'node_modules', '.bin', name);
  const startedMs = Date.now();
  execFileSync(bin('electron-vite'), ['build'], { cwd: root, stdio: 'inherit', shell: false });
  execFileSync(bin('electron-builder'), electronBuilderReleaseArgs(arches, signer), { cwd: root, stdio: 'inherit', shell: false });
  // The update ZIPs are checked with the apps, before anything is submitted to the Notary Service.
  const appProblems = arches.flatMap((arch) => [
    ...macReleaseAppProblems(root, arch, startedMs, signer),
    ...verifyMacReleaseZip(macReleaseZipPath(root, version, arch), arch, startedMs, signer),
  ]);
  if (appProblems.length > 0) {
    refuse(appProblems);
  }
  const dmgs = arches.map((arch) => macReleaseDmgPath(root, version, arch));
  const dmgProblems = dmgs.flatMap((dmg) => notarizeMacReleaseDmg(dmg, profile, startedMs, signer));
  if (dmgProblems.length > 0) {
    refuse(dmgProblems);
  }
  console.log('Signed, notarized, stapled and Gatekeeper-accepted release DMG(s), and verified update ZIP(s):');
  for (const artifact of [...dmgs, ...arches.map((arch) => macReleaseZipPath(root, version, arch))]) {
    console.log(`  ${artifact}`);
  }
  console.log('Sign and stage the update manifests with electron.update-release.ts (docs/PACKAGING.md, "Stable updates").');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
