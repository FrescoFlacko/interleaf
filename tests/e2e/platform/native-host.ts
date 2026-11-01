/**
 * Fails a native-only case on any other host, with the command that does run
 * there. A wrong-host native case is a routing mistake, never a quiet skip.
 */
const NATIVE = {
  darwin: { project: 'macos-native', os: 'macOS', other: '--project=shared --project=linux-native' },
  linux: { project: 'linux-native', os: 'Linux', other: '--project=shared --project=macos-native' },
} as const;

export function requireNativeHost(required: keyof typeof NATIVE, host: NodeJS.Platform = process.platform): void {
  if (host === required) return;
  const native = NATIVE[required];
  throw new Error(
    `The ${native.project} project requires ${native.os}; this host is ${host}. ` +
      `Run the native project on its own OS, and on this host use: npx playwright test ${host === 'darwin' ? NATIVE.linux.other : NATIVE.darwin.other}`,
  );
}

/**
 * macOS-native cases are kept and classified but not run: by owner decision
 * there is no macOS CI, so they are skipped by default with this reason and
 * nothing claims they pass. `INTERLEAF_E2E_MACOS_NATIVE=1` opts in on a Mac;
 * that run is unverified until macOS CI exists.
 */
export const MACOS_NATIVE_DEFERRED =
  'Deferred by owner decision: there is no macOS CI, so macOS-native cases are not run or verified. ' +
  'Set INTERLEAF_E2E_MACOS_NATIVE=1 on a Mac to opt in (unverified).';

export function macosNativeDeferred(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTERLEAF_E2E_MACOS_NATIVE !== '1';
}
