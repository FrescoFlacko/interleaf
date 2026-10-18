import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * The quality gate runs `eslint .` with no exclude arguments (scripts/quality/gate.py),
 * so ESLint's traversal is defined solely by the `ignores` list in eslint.config.mjs,
 * while the gate passes its own SKIP_DIRS to the code scanner as `**\/<name>/**`.
 * When those two inventories drift, ESLint walks directories the gate already treats
 * as generated. That drift previously left nested Git worktrees lintable: a root run
 * enumerated every duplicate checkout and, because those copies sit outside the root
 * tsconfig, `projectService` opened a separate TypeScript program per checkout until
 * the default V8 heap was exhausted.
 *
 * These checks use `isPathIgnored` only: no files are linted and no TypeScript program
 * is created, so the regression stays cheap. Paths need not exist on disk.
 */

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Directory names the gate excludes, read from the gate itself so the two cannot drift. */
async function gateSkipDirectories(): Promise<string[]> {
  const source = await readFile(new URL('../../scripts/quality/gate.py', import.meta.url), 'utf8');
  const literal = /SKIP_DIRS\s*=\s*\{([\s\S]*?)\}/.exec(source);
  expect(literal, 'SKIP_DIRS literal not found in scripts/quality/gate.py').not.toBeNull();
  const names = [...(literal?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
  expect(names.length).toBeGreaterThan(0);
  return names;
}

describe('eslint.config.mjs ignore inventory', () => {
  let eslint: ESLint;
  let skipDirectories: string[];

  beforeAll(async () => {
    eslint = new ESLint({ cwd: repositoryRoot });
    skipDirectories = await gateSkipDirectories();
  });

  it('ignores every generated directory the quality gate excludes, at any depth', async () => {
    for (const name of skipDirectories) {
      await expect(
        eslint.isPathIgnored(`${name}/probe.ts`),
        `${name}/ must be ignored at the repository root`,
      ).resolves.toBe(true);
      await expect(
        eslint.isPathIgnored(`src/main/${name}/probe.ts`),
        `${name}/ must be ignored when nested, matching the gate's **/${name}/** exclude`,
      ).resolves.toBe(true);
    }
  });

  it('ignores nested Git worktrees so a root run cannot enumerate duplicate checkouts', async () => {
    for (const path of [
      '.worktrees/beta-release/src/main/index.ts',
      '.worktrees/any-branch/src/renderer/app.tsx',
      '.worktrees/any-branch/tests/unit/example.spec.ts',
      '.worktrees/any-branch/vitest.config.ts',
    ]) {
      await expect(eslint.isPathIgnored(path), `${path} must not be linted`).resolves.toBe(true);
    }
  });

  it('still lints every real production and test source', async () => {
    for (const path of [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/shared/agent-context.ts',
      'src/renderer/features/reader/adapters/markdown-adapter.ts',
      'tests/unit/eslint-config-ignores.spec.ts',
      'tests/integration/probe.spec.ts',
      'tests/renderer/probe.spec.tsx',
      'vitest.config.ts',
      'electron.vite.config.ts',
      'wiki.build.ts',
    ]) {
      await expect(eslint.isPathIgnored(path), `${path} must stay linted`).resolves.toBe(false);
    }
  });

  it('excludes only the four named design exports, not their siblings', async () => {
    for (const name of ['AI Chat UI Redesign', 'AI Chat UI Redesign (1)', 'AI Chat UI Redesign (2)', 'AI Chat UI Redesign (5)']) {
      await expect(eslint.isPathIgnored(`${name}/probe.ts`)).resolves.toBe(true);
    }
    for (const name of ['AI Chat UI Redesign (3)', 'AI Chat UI Redesign (4)', 'AI Chat UI Redesign (6)']) {
      await expect(
        eslint.isPathIgnored(`${name}/probe.ts`),
        `${name} is not an approved exclusion and must stay covered`,
      ).resolves.toBe(false);
    }
  });

  it('keeps the audited upstream vendor directory ignored', async () => {
    await expect(
      eslint.isPathIgnored('src/renderer/features/reader/adapters/foliate/upstream/view.js'),
    ).resolves.toBe(true);
  });
});
