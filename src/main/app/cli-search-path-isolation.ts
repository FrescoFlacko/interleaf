import { brandEnvFlagEnabled } from './brand-env';

/**
 * Test-harness isolation for CLI discovery.
 *
 * When latched, `buildCliSearchPath` hands every lookup and child the
 * inherited PATH exactly, so an automated run can see only the fixture
 * directories it was launched with and never a host-installed CLI. One-way for
 * the process lifetime; nothing turns it back off.
 */
let inheritedPathOnly = false;

export type CliSearchPathRestrictionInput = {
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
};

/**
 * Latches the exact-inherited-PATH mode only for an unpackaged app launched
 * with `INTERLEAF_ISOLATED_CLI_PATH=1`. A packaged app ignores the variable,
 * the renderer cannot reach it, and it never supplies a path of its own.
 */
export function applyTestCliSearchPathRestriction(input: CliSearchPathRestrictionInput): boolean {
  if (input.isPackaged || !brandEnvFlagEnabled('ISOLATED_CLI_PATH', input.env)) return false;
  inheritedPathOnly = true;
  return true;
}

/** Whether well-known install directories are appended on this platform. */
export function appendsWellKnownDirectories(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && !inheritedPathOnly;
}
