import path from 'node:path';
import type { Project } from '@playwright/test';

/**
 * The Electron suite's projects. `shared` holds every case whose behaviour is
 * the same on macOS and Linux; `macos-native` and `linux-native` hold the
 * assertions that need that OS's own APIs (CoreGraphics, lsappinfo and the
 * Dock; the X server's input focus and map state). Every project waits for
 * `platform-preflight`, which fails the run when the host cannot provide what
 * the selected job needs.
 *
 * Only the host's own native project is offered, so asking for the other one
 * fails as an unknown project instead of running nothing.
 * `INTERLEAF_E2E_ALL_PROJECTS=1` lists every project for static collection;
 * a native case run that way on the wrong host fails its host guard.
 */
const E2E_DIR = path.join(__dirname, '..');

export function platformProjects(host: NodeJS.Platform, env: NodeJS.ProcessEnv): Project[] {
  const all = env.INTERLEAF_E2E_ALL_PROJECTS === '1';
  const projects: Project[] = [
    { name: 'platform-preflight', testDir: path.join(E2E_DIR, 'platform'), testMatch: /platform[\\/]preflight\.spec\.ts$/u },
    { name: 'shared', testDir: E2E_DIR, testIgnore: ['**/platform/**'], dependencies: ['platform-preflight'] },
  ];
  if (all || host === 'linux') projects.push({ name: 'linux-native', testDir: path.join(E2E_DIR, 'platform', 'linux'), dependencies: ['platform-preflight'] });
  if (all || host === 'darwin') projects.push({ name: 'macos-native', testDir: path.join(E2E_DIR, 'platform', 'macos'), dependencies: ['platform-preflight'] });
  return projects;
}
