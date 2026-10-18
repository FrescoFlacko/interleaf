import type { Plugin } from 'vitest/config';

/**
 * Test-runner plugin: treat `node:sqlite` as the Node built-in it is.
 *
 * `node:sqlite` is still flagged experimental, so Node leaves it out of
 * `module.builtinModules`. Vitest replaces Vite's externalization list with
 * exactly that array (`config.resolve.external = [...builtinModules, ...]` in
 * its `vitest:environments-module-runner` plugin), so a jsdom-environment test
 * that reaches main-process code fails to load with "Cannot bundle built-in
 * module" and no declarative option can express the exception — the value is
 * overwritten after user config is merged.
 *
 * Declaring it here states what is already true: it is a Node built-in, never
 * bundled and never reachable from a real renderer. It applies only to how the
 * test runner loads modules. Production bundling is configured in
 * `electron.vite.config.ts` and is untouched by this file.
 */
export const externalNodeSqlite: Plugin = {
  name: 'interleaf:external-node-sqlite',
  enforce: 'pre',
  resolveId(id) {
    return id === 'node:sqlite' ? { id, external: true } : null;
  },
};
