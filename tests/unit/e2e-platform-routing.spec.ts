import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { platformProjects } from '../e2e/platform/projects';
import { MACOS_NATIVE_DEFERRED, macosNativeDeferred, requireNativeHost } from '../e2e/platform/native-host';
import { evaluatePreflight, preflightRequirements, type PreflightProbes } from '../e2e/platform/preflight';

/**
 * The Electron suite's platform routing: which project runs which spec on which
 * host, what a native project does on the wrong host, and which capabilities a
 * Linux run must have before any test starts.
 */

const ROOT = join(__dirname, '..', '..');
const E2E = join(ROOT, 'tests', 'e2e');

function specFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return specFiles(full);
    return name.endsWith('.spec.ts') ? [relative(E2E, full)] : [];
  });
}

const names = (host: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): string[] => platformProjects(host, env).map((project) => project.name ?? '');

describe('E2E platform projects', () => {
  it('runs shared plus the host-native project behind one preflight', () => {
    expect(names('linux')).toEqual(['platform-preflight', 'shared', 'linux-native']);
    expect(names('darwin')).toEqual(['platform-preflight', 'shared', 'macos-native']);
    for (const project of platformProjects('linux', {})) {
      if (project.name !== 'platform-preflight') expect(project.dependencies).toEqual(['platform-preflight']);
    }
  });

  it('does not offer the other OS native project, so requesting it fails as an unknown project', () => {
    expect(names('linux')).not.toContain('macos-native');
    expect(names('darwin')).not.toContain('linux-native');
  });

  it('lists every project for static collection when asked to', () => {
    expect(names('linux', { INTERLEAF_E2E_ALL_PROJECTS: '1' })).toEqual(['platform-preflight', 'shared', 'linux-native', 'macos-native']);
  });

  it('offers only shared on an unsupported host, whose preflight then fails', () => {
    expect(names('win32')).toEqual(['platform-preflight', 'shared']);
  });

  it('routes every spec file to exactly one project by directory', () => {
    const projects = platformProjects('linux', { INTERLEAF_E2E_ALL_PROJECTS: '1' });
    const shared = projects.find((project) => project.name === 'shared')!;
    expect(shared.testIgnore).toEqual(['**/platform/**']);
    const owner = (file: string): string[] => {
      if (file === 'platform/preflight.spec.ts') return ['platform-preflight'];
      if (file.startsWith('platform/linux/')) return ['linux-native'];
      if (file.startsWith('platform/macos/')) return ['macos-native'];
      if (file.startsWith('platform/')) return ['unrouted'];
      return ['shared'];
    };
    for (const file of specFiles(E2E)) expect(owner(file), file).toHaveLength(1);
    expect(specFiles(E2E).filter((file) => owner(file)[0] === 'unrouted')).toEqual([]);
    expect(projects.find((project) => project.name === 'linux-native')!.testDir).toMatch(/tests\/e2e\/platform\/linux$/u);
    expect(projects.find((project) => project.name === 'macos-native')!.testDir).toMatch(/tests\/e2e\/platform\/macos$/u);
  });

  it('keeps macOS-only APIs out of shared specs and guards every native spec with its real host', () => {
    const macApi = /lsappinfo|swiftc|window-order\.swift|\.dock\b|CoreGraphics|process\.platform !== 'darwin'/u;
    for (const file of specFiles(E2E)) {
      const source = readFileSync(join(E2E, file), 'utf8');
      if (file === 'platform/preflight.spec.ts') {
        expect(source, file).toContain('evaluatePreflight');
      } else if (file.startsWith('platform/macos/')) {
        expect(source, file).toContain("requireNativeHost('darwin')");
        expect(source, `${file} must stay deferred by default`).toContain('test.skip(macosNativeDeferred(), MACOS_NATIVE_DEFERRED)');
      } else if (file.startsWith('platform/linux/')) {
        expect(source, file).toContain("requireNativeHost('linux')");
        expect(source, `${file} must not be deferred`).not.toContain('macosNativeDeferred');
      } else {
        expect(source, `${file} must not be deferred`).not.toContain('macosNativeDeferred');
        expect(macApi.test(source), `${file} uses a macOS-only API outside the macos-native project`).toBe(false);
      }
    }
  });
});

describe('macOS-native deferral', () => {
  it('skips macOS-native cases by default, with the owner reason, until explicitly opted in', () => {
    expect(macosNativeDeferred({})).toBe(true);
    expect(macosNativeDeferred({ INTERLEAF_E2E_MACOS_NATIVE: '0' })).toBe(true);
    expect(macosNativeDeferred({ INTERLEAF_E2E_MACOS_NATIVE: '1' })).toBe(false);
    expect(MACOS_NATIVE_DEFERRED).toMatch(/owner.*no macOS CI.*INTERLEAF_E2E_MACOS_NATIVE=1.*unverified/su);
  });
});

describe('native host guard', () => {
  it('passes on the host the native project targets', () => {
    expect(() => { requireNativeHost('linux', 'linux'); }).not.toThrow();
    expect(() => { requireNativeHost('darwin', 'darwin'); }).not.toThrow();
  });

  it('fails with an actionable message instead of skipping on the wrong host', () => {
    expect(() => { requireNativeHost('darwin', 'linux'); }).toThrow(/macos-native.*requires macOS.*this host is linux.*--project=shared --project=linux-native/su);
    expect(() => { requireNativeHost('linux', 'darwin'); }).toThrow(/linux-native.*requires Linux.*this host is darwin.*--project=shared --project=macos-native/su);
  });
});

describe('platform preflight', () => {
  it('proves a declared credential store with a bounded round trip through the app, not just a bus name', () => {
    const setup = readFileSync(join(E2E, 'platform', 'preflight.spec.ts'), 'utf8');
    for (const step of ['configureOpenRouter', 'getOpenRouterStatus', 'clearOpenRouterKey', 'did not answer within']) expect(setup).toContain(step);
    expect(setup).toContain("process.env.INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE !== '1'");
  });

  const linuxOk: PreflightProbes = { x11Display: true, xdpyinfo: true, x11Library: true, secretService: true };

  it('requires an X11 display, xdpyinfo and libX11 on every Linux run', () => {
    expect(preflightRequirements('linux', { DISPLAY: ':93' }).map((requirement) => requirement.id)).toEqual(['x11-display', 'xdpyinfo', 'x11-library']);
    expect(evaluatePreflight('linux', { DISPLAY: ':93' }, linuxOk)).toEqual([]);
  });

  it('fails closed when a required Linux capability is missing', () => {
    expect(evaluatePreflight('linux', {}, { ...linuxOk, x11Display: false })).toEqual([
      'x11-display: no reachable X11 display (DISPLAY is unset); start one, e.g. Xvfb :99, and export DISPLAY',
    ]);
    expect(evaluatePreflight('linux', { DISPLAY: ':93' }, { ...linuxOk, x11Library: false })[0]).toMatch(/^x11-library: /u);
    // Without a display the libX11 probe cannot run; only the display is reported.
    expect(evaluatePreflight('linux', {}, { ...linuxOk, x11Display: false, x11Library: false })).toHaveLength(1);
  });

  it('reports Wayland-only sessions as unsupported rather than passing', () => {
    expect(evaluatePreflight('linux', { WAYLAND_DISPLAY: 'wayland-0' }, { ...linuxOk, x11Display: false })[0])
      .toMatch(/^x11-display: .*Wayland.*not a supported E2E display/u);
  });

  it('adds the isolated secret service when a job declares the credential store', () => {
    const env = { DISPLAY: ':93', INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE: '1' };
    expect(preflightRequirements('linux', env).map((requirement) => requirement.id)).toContain('credential-store');
    expect(evaluatePreflight('linux', env, { ...linuxOk, secretService: false })).toEqual([
      'credential-store: the job requires a credential store but INTERLEAF_E2E_LINUX_SECRET_SERVICE is not 1; run under tests/e2e/run-with-linux-keyring.sh',
    ]);
    expect(evaluatePreflight('linux', { ...env, INTERLEAF_E2E_LINUX_SECRET_SERVICE: '1' }, { ...linuxOk, secretService: false })).toEqual([
      'credential-store: no secret service owns org.freedesktop.secrets on the session bus',
    ]);
  });

  it('fails a job declared for another platform, and any unsupported host', () => {
    expect(evaluatePreflight('linux', { DISPLAY: ':93', INTERLEAF_E2E_PLATFORM: 'macos' }, linuxOk)).toEqual([
      'platform: this job is declared for macos but the host is linux',
    ]);
    expect(evaluatePreflight('win32', {}, linuxOk)).toEqual([
      'platform: win32 is not a supported E2E host (the suite uses a POSIX PATH and /bin/sh fixtures); use macOS or Linux',
    ]);
    expect(evaluatePreflight('darwin', { INTERLEAF_E2E_PLATFORM: 'macos' }, linuxOk)).toEqual([]);
  });
});

describe('E2E CI routing', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'e2e.yml'), 'utf8');
  const job = (name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start, `job ${name}`).toBeGreaterThan(-1);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/u);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };

  it('has no active macOS job while macOS-native cases are deferred', () => {
    expect(workflow).not.toMatch(/runs-on:\s*macos/u);
    expect(workflow).not.toContain('macos-native');
    expect(workflow.indexOf('\n  macos:\n')).toBe(-1);
  });

  it('runs Linux with its own native project, declared capabilities and no retries', () => {
    const linux = job('linux');
    expect(linux).toContain('runs-on: ubuntu-latest');
    expect(linux).toContain('INTERLEAF_E2E_PLATFORM: linux');
    expect(linux).toContain("INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE: '1'");
    expect(linux).toContain('tests/e2e/run-with-linux-keyring.sh npx playwright test --project=shared --project=linux-native --retries=0');
    expect(linux).not.toContain('macos-native');
  });

  it("keeps second launches sandboxed by setting up exactly Electron's setuid helper after install", () => {
    const linux = job('linux');
    const helper = 'node_modules/electron/dist/chrome-sandbox';
    const install = linux.indexOf('run: npm ci');
    const setup = linux.indexOf(`sudo chown root:root "${helper}"`);
    expect(install).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(install);
    expect(linux).toContain(`sudo chmod 4755 "${helper}"`);
    // Only that one regular file: no recursion, no sandbox opt-out, no user-namespace policy change.
    expect(linux).not.toMatch(/(chown|chmod)\s+-[a-zA-Z]*R/u);
    expect(workflow).not.toMatch(/no-sandbox|ELECTRON_DISABLE_SANDBOX|disable-setuid-sandbox|unprivileged_userns|apparmor/u);
  });
});

describe('development Node.js version', () => {
  const WORKFLOWS = join(ROOT, '.github', 'workflows');
  const workflows = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/u.test(name));

  it('pins the project to Node.js 26 locally', () => {
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8')).toBe('26\n');
  });

  it('sets up Node.js 26, and only 26, in every job of every project workflow that sets up Node', () => {
    expect(workflows.length).toBeGreaterThan(0);
    let setups = 0;
    for (const name of workflows) {
      const source = readFileSync(join(WORKFLOWS, name), 'utf8');
      const setupCount = source.match(/uses: actions\/setup-node@/gu)?.length ?? 0;
      const versions = [...source.matchAll(/node-version:\s*(\S+)/gu)].map((match) => match[1]);
      expect(versions, name).toEqual(Array<string>(setupCount).fill("'26'"));
      setups += setupCount;
    }
    // e2e (Linux) plus linux-package (package and AppImage update smoke).
    expect(setups).toBe(3);
  });
});
