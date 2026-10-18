import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Directories Vite may read from during a test run.
 *
 * In a Git worktree, `node_modules` is commonly populated by linking each
 * package back to the primary checkout. Vite resolves through those links
 * before applying `server.fs.allow`, so the real dependency tree sits outside
 * the project root and every spec that reaches a `?url` import (the pdf.js
 * worker, for one) fails to load. Resolving one known package to its real path
 * adds the actual dependency root; in an ordinary checkout that is just the
 * project's own `node_modules` and the extra entry is a no-op.
 */
export function allowedFsRoots(projectRoot: string): readonly string[] {
  const modules = resolve(projectRoot, 'node_modules');
  try {
    return [projectRoot, modules, dirname(realpathSync(resolve(modules, 'vite')))];
  } catch {
    return [projectRoot, modules];
  }
}
