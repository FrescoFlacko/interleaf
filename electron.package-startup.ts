import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication } from '@playwright/test';

/**
 * Startup smoke check for a packaged macOS app, launched the way an installed
 * app is: from the neutral working directory `/`.
 *
 * The 0.2.0 arm64 release resolved worker dependencies from `process.cwd()`.
 * Every earlier check launched it from the source checkout, where the
 * checkout's own `node_modules` satisfied that lookup, so the package passed
 * and the installed app then failed at startup with `Cannot find module
 * 'fflate'` (require stack `//package.json`). The dependency check in
 * `electron.package-dependencies.ts` only reads `app.asar`; this one runs it.
 *
 * The launch uses a fresh temporary profile through `INTERLEAF_USER_DATA`, an
 * OS-only `PATH` (no provider CLI is discoverable, so no paid call is
 * possible), a temporary `HOME`, and bounded launch/window/close deadlines. It
 * refuses an app under `/Applications`, so an installed copy is never started.
 */

const NEUTRAL_CWD = '/';
const LAUNCH_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARS = 64 * 1024;
const OS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const NO_WINDOW = `no window opened within ${String(LAUNCH_TIMEOUT_MS / 1000)} s. A packaged app that throws while loading its main module (for example \`Cannot find module\`) reports it only in a modal dialog, not on stderr; launch the executable from / to read it`;

export type StartupReport = { readonly userData: string; readonly cwd: string; readonly isPackaged: boolean };

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The bundle's main executable. */
export const packagedExecutable = (appPath: string): string => join(appPath, 'Contents', 'MacOS', 'Interleaf');

/** Reasons the given bundle must not be launched by this check. */
export function packagedStartupTargetProblems(appPath: string): string[] {
  if (!existsSync(packagedExecutable(appPath))) {
    return [`${packagedExecutable(appPath)} does not exist`];
  }
  const canonical = realpathSync(appPath);
  return isInside('/Applications', canonical) ? [`${canonical} is an installed app; run this check against a package under release/ or a mounted DMG`] : [];
}

/** The complete environment for the launched app: nothing is inherited from the host. */
export function packagedStartupEnvironment(sandbox: string): { PATH: string; HOME: string; TMPDIR: string; INTERLEAF_USER_DATA: string } {
  return {
    PATH: OS_PATH,
    HOME: join(sandbox, 'home'),
    TMPDIR: join(sandbox, 'tmp'),
    INTERLEAF_USER_DATA: join(sandbox, 'user-data'),
  };
}

/** What makes a launch a failure, given what the running app reported about itself (nothing if it never opened a window). */
export function packagedStartupProblems(report: StartupReport | undefined, expectedUserData: string): string[] {
  if (report === undefined) {
    return [NO_WINDOW];
  }
  const problems: string[] = [];
  if (report.cwd !== NEUTRAL_CWD) problems.push(`app ran from ${report.cwd}, not ${NEUTRAL_CWD}`);
  if (report.userData !== expectedUserData) problems.push(`app used profile ${report.userData}, not the isolated ${expectedUserData}`);
  if (!report.isPackaged) problems.push('app did not report itself as packaged');
  return problems;
}

async function launchAndReport(executablePath: string, env: Record<string, string>, stderr: string[]): Promise<{ app: ElectronApplication | undefined; report: StartupReport | undefined }> {
  // Playwright's launch itself waits for the main module to load, so a module
  // that throws at load time surfaces here as a launch timeout.
  const app = await _electron.launch({ executablePath, cwd: NEUTRAL_CWD, env, args: [], timeout: LAUNCH_TIMEOUT_MS }).catch(() => undefined);
  if (app === undefined) {
    return { app, report: undefined };
  }
  app.process().stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'));
    if (stderr.join('').length > MAX_STDERR_CHARS) stderr.shift();
  });
  try {
    const window = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await window.waitForLoadState('domcontentloaded', { timeout: LAUNCH_TIMEOUT_MS });
    const report = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      cwd: process.cwd(),
      isPackaged: electronApp.isPackaged,
    }));
    return { app, report };
  } catch {
    return { app, report: undefined };
  }
}

async function closeWithin(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const deadline = new Promise<void>((resolveDeadline) => setTimeout(resolveDeadline, CLOSE_TIMEOUT_MS).unref());
  await Promise.race([app.close().catch(() => undefined), deadline]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** `node electron.package-startup.ts <path/to/Interleaf.app>`: launches the package from `/` with an isolated profile. */
async function main(): Promise<void> {
  const appPath = process.argv[2];
  if (appPath === undefined || process.argv.length !== 3) {
    console.error('Usage: node electron.package-startup.ts <path/to/Interleaf.app>');
    process.exit(2);
  }
  const targetProblems = packagedStartupTargetProblems(resolve(appPath));
  if (targetProblems.length > 0) {
    for (const problem of targetProblems) console.error(`  - ${problem}`);
    process.exit(2);
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'interleaf-package-startup-'));
  const env = packagedStartupEnvironment(sandbox);
  for (const directory of [env.HOME, env.TMPDIR]) mkdirSync(directory, { recursive: true });
  const stderr: string[] = [];
  let problems: string[];
  try {
    const { app, report } = await launchAndReport(packagedExecutable(resolve(appPath)), env, stderr);
    if (app !== undefined) await closeWithin(app);
    problems = packagedStartupProblems(report, env.INTERLEAF_USER_DATA);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(stderr.join(''));
    process.exit(1);
  }
  console.log(`${appPath}: started from ${NEUTRAL_CWD} with an isolated profile and opened its window.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
