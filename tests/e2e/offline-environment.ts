import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The environment every Electron launch in this suite runs inside.
 *
 * Two host facts leaked into the suite and made its results depend on the
 * machine it ran on rather than on the code under test:
 *
 * 1. `PATH` was inherited from the developer's shell. CLI providers and agent
 *    profiles are discovered by looking a binary up on `PATH` and running it,
 *    so on a machine with `codex`, `claude`, `pi` or `omp` installed the app
 *    discovered real, authenticated providers — and a chat turn could reach a
 *    paid account. On a machine without them the same specs saw nothing.
 * 2. The `local` provider probes a loopback address that is a fixed default
 *    (`127.0.0.1:11434`, Ollama's port). A fresh E2E profile therefore adopts
 *    it, and on a machine running Ollama the app discovered a ready provider
 *    that no test asked for. That is the provider the suite bound sessions to
 *    when a spec expected OpenRouter. That half is closed in
 *    `offline-local-server.ts`, which owns the server the app talks to and
 *    records what it was asked.
 *
 * Both are closed centrally rather than per spec, because a spec that forgets
 * is a spec that quietly runs against a real provider. Nothing in the
 * application changes: the app still performs its own real `PATH` lookup and
 * its own real loopback probe, and a fixture CLI a spec supplies is found
 * exactly the way a user-installed one would be.
 *
 * POSIX-only, like the rest of this suite (the existing CLI fixtures are
 * `/bin/sh` scripts).
 */

/**
 * The only directories an app under test may search for executables.
 *
 * An allowlist rather than a denylist: dropping the directories that happen to
 * hold a provider binary today leaves the next one to be installed
 * discoverable, and those directories (`~/.local/bin`, `/opt/homebrew/bin`,
 * a Node version manager's `bin`) are exactly where provider CLIs live. These
 * four are OS-owned, are where `git`, `sh` and `which` live — which main
 * genuinely spawns — and are not a place a provider CLI installs itself.
 */
const OFFLINE_PATH_DIRECTORIES: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Every executable name the application looks up on `PATH`.
 *
 * Kept in sync with the CLI chat providers (`cli-ai-provider.ts`) and the agent
 * profile binaries (`settings-repository.ts`); it is asserted against the
 * sanitized `PATH` before the suite runs, so a name added there without being
 * added here only weakens the assertion, never the allowlist above.
 */
const HOST_PROVIDER_BINARIES: readonly string[] = [
  'codex',
  'claude',
  'agy',
  'copilot',
  'opencode',
  'pi',
  'cursor-agent',
  'omp',
  'gemini',
];

/** Executables main really does spawn, which the allowlist must still supply. */
const REQUIRED_SYSTEM_BINARIES: readonly string[] = ['git', 'sh', 'which'];

/**
 * The `PATH` for an app under test: the allowlist, with a fixture directory in
 * front when a spec supplies one.
 */
export function offlinePath(binDir?: string): string {
  const directories = binDir === undefined ? OFFLINE_PATH_DIRECTORIES : [binDir, ...OFFLINE_PATH_DIRECTORIES];
  return directories.join(path.delimiter);
}

/** Resolves `name` against `searchPath` the way an OS `PATH` lookup would. */
function resolveOnPath(name: string, searchPath: string): string | null {
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Environment variable names an app under test never needs and must not see.
 *
 * No provider in this application reads a credential from the environment —
 * keys live in the profile's encrypted store — so this removes nothing the app
 * uses. It is depth: a shell that exports `ANTHROPIC_API_KEY` should not be
 * able to make a test run bill somebody, whatever a future code path decides
 * to read.
 */
const SECRET_ENVIRONMENT_NAME = /(API|AUTH|BEARER|CREDENTIAL|KEY|PASS(?:WORD|WD)?|SECRET|TOKEN|ANTHROPIC|OPENROUTER|OPENAI|GEMINI|CLAUDE|CODEX|AWS|AZURE|GITHUB|GOOGLE)/iu;

/** `process.env` with credential-shaped entries removed. */
function offlineEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENVIRONMENT_NAME.test(name))
  );
}

/**
 * Per-user locations a provider CLI or its configuration can be found through.
 * The app's macOS CLI discovery derives install directories from `HOME`, and a
 * CLI reads its own sign-in state from there, so none of these may describe the
 * person running the suite.
 */
const HOST_PROFILE_ENVIRONMENT_NAME = /^(?:XDG_|NVM_|BUN_|HOMEBREW_|VOLTA_|PNPM_HOME$|ZDOTDIR$)/u;

/**
 * The complete environment for one app under test.
 *
 * `isolatedHome` is a throwaway directory created for this launch; it becomes
 * the child's `HOME` only — the runner's own `HOME` is never changed. The
 * `ISOLATED_CLI_PATH` flag confines main's CLI lookup to the `PATH` given
 * here (an unpackaged-only test switch in `cli-search-path-isolation.ts`), so no
 * Homebrew, `/usr/local` or per-user directory is appended behind it.
 */
export function isolatedLaunchEnvironment(options: {
  readonly isolatedHome: string;
  readonly binDir?: string | undefined;
}): NodeJS.ProcessEnv {
  const inherited = Object.entries(offlineEnvironment()).filter(([name]) => !HOST_PROFILE_ENVIRONMENT_NAME.test(name));
  return {
    ...Object.fromEntries(inherited),
    HOME: options.isolatedHome,
    PATH: offlinePath(options.binDir),
    INTERLEAF_ISOLATED_CLI_PATH: '1',
  };
}

/**
 * Chromium's mock keychain: Electron `safeStorage` encrypts the suite's
 * placeholder keys without reading or writing the host's login keychain.
 */
export const ISOLATED_ELECTRON_SWITCHES: readonly string[] = ['--use-mock-keychain'];

/**
 * Fails the run — before any application starts — if the sanitized `PATH`
 * could still reach a real provider CLI, or has lost something main needs.
 */
export function assertOfflinePathIsSafe(): void {
  const searchPath = offlinePath();
  const reachable = HOST_PROVIDER_BINARIES.map((name) => ({ name, at: resolveOnPath(name, searchPath) })).filter(
    (entry) => entry.at !== null
  );
  if (reachable.length > 0) {
    throw new Error(
      `E2E offline guarantee failed: real provider binaries are reachable on the sanitized PATH: ${reachable
        .map((entry) => `${entry.name} -> ${String(entry.at)}`)
        .join(', ')}`
    );
  }
  const missing = REQUIRED_SYSTEM_BINARIES.filter((name) => resolveOnPath(name, searchPath) === null);
  if (missing.length > 0) {
    throw new Error(`E2E offline guarantee failed: the sanitized PATH is missing ${missing.join(', ')}`);
  }
}
