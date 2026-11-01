import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * What a host must provide before any Electron case runs, and why. Linux runs
 * need an X11 display (Playwright starts Electron with the X11 Ozone backend),
 * `xdpyinfo` to prove it is reachable and libX11 for the X server reads the
 * linux-native cases make. A job that declares the credential store
 * (`INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE=1`) also needs the disposable
 * secret service from `tests/e2e/run-with-linux-keyring.sh`. Nothing here reads
 * or reports environment values beyond these names.
 */
export type PreflightProbes = {
  readonly x11Display: boolean;
  readonly xdpyinfo: boolean;
  readonly x11Library: boolean;
  readonly secretService: boolean;
};

export type PreflightRequirement = { readonly id: 'x11-display' | 'xdpyinfo' | 'x11-library' | 'credential-store'; readonly why: string };

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', linux: 'linux' };
const XDPYINFO = '/usr/bin/xdpyinfo';
const X11_WINDOW_STATE = path.join(__dirname, '..', '..', 'fixtures', 'x11-window-state.py');

export function preflightRequirements(host: NodeJS.Platform, env: NodeJS.ProcessEnv): readonly PreflightRequirement[] {
  if (host !== 'linux') return [];
  const requirements: PreflightRequirement[] = [
    { id: 'x11-display', why: 'Electron runs on the X11 Ozone backend' },
    { id: 'xdpyinfo', why: 'proves the display is reachable' },
    { id: 'x11-library', why: 'linux-native cases read X input focus and map state' },
  ];
  if (env.INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE === '1') requirements.push({ id: 'credential-store', why: 'the job declares credential workflows' });
  return requirements;
}

function failure(id: PreflightRequirement['id'], env: NodeJS.ProcessEnv, probes: PreflightProbes): string | null {
  switch (id) {
    case 'x11-display':
      if (probes.x11Display) return null;
      if (env.DISPLAY === undefined && env.WAYLAND_DISPLAY !== undefined) {
        return 'x11-display: only a Wayland session is present; Wayland is not a supported E2E display, start an X11 server (e.g. Xvfb :99) and export DISPLAY';
      }
      return `x11-display: no reachable X11 display (${env.DISPLAY === undefined ? 'DISPLAY is unset' : 'DISPLAY does not answer'}); start one, e.g. Xvfb :99, and export DISPLAY`;
    case 'xdpyinfo':
      return probes.xdpyinfo ? null : `xdpyinfo: ${XDPYINFO} is missing; install x11-utils on the runner`;
    case 'x11-library':
      // Without a display the probe cannot run; the display failure says why.
      return probes.x11Library || !probes.x11Display ? null : 'x11-library: python3 could not load libX11 through tests/fixtures/x11-window-state.py; install python3 and libx11-6 on the runner';
    case 'credential-store':
      if (env.INTERLEAF_E2E_LINUX_SECRET_SERVICE !== '1') {
        return 'credential-store: the job requires a credential store but INTERLEAF_E2E_LINUX_SECRET_SERVICE is not 1; run under tests/e2e/run-with-linux-keyring.sh';
      }
      return probes.secretService ? null : 'credential-store: no secret service owns org.freedesktop.secrets on the session bus';
  }
}

export function evaluatePreflight(host: NodeJS.Platform, env: NodeJS.ProcessEnv, probes: PreflightProbes): string[] {
  const hostName = PLATFORM_NAMES[host];
  if (hostName === undefined) {
    return [`platform: ${host} is not a supported E2E host (the suite uses a POSIX PATH and /bin/sh fixtures); use macOS or Linux`];
  }
  const declared = env.INTERLEAF_E2E_PLATFORM;
  if (declared !== undefined && declared !== hostName) return [`platform: this job is declared for ${declared} but the host is ${host}`];
  return preflightRequirements(host, env).flatMap((requirement) => failure(requirement.id, env, probes) ?? []);
}

function succeeds(file: string, args: readonly string[]): boolean {
  try {
    execFileSync(file, args, { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Probes the real host. Linux only; other hosts need nothing probed. */
export function probeHost(host: NodeJS.Platform, env: NodeJS.ProcessEnv): PreflightProbes {
  if (host !== 'linux') return { x11Display: true, xdpyinfo: true, x11Library: true, secretService: true };
  const display = env.DISPLAY;
  const xdpyinfo = succeeds(XDPYINFO, ['-version']);
  return {
    x11Display: display !== undefined && xdpyinfo && succeeds(XDPYINFO, ['-display', display]),
    xdpyinfo,
    x11Library: display !== undefined && succeeds('/usr/bin/python3', ['-I', X11_WINDOW_STATE, '--probe', display]),
    secretService: succeeds('/usr/bin/dbus-send', [
      '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.GetNameOwner', 'string:org.freedesktop.secrets',
    ]),
  };
}
