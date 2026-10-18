import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { resolve } from 'node:path';

/**
 * The `any`/`unknown` ban is a lint rule, so it only holds where lint runs.
 *
 * The vendored foliate directory is the one place in `src/` that is ignored,
 * and it holds both exact upstream JavaScript and the hand-written ambient
 * declaration that describes it. An ignore written one directory too wide would
 * silently exempt that declaration: the file would still typecheck, still be
 * imported by the MOBI parser, and still be free to say `unknown`. That is what
 * this proves cannot happen again — the declaration is linted, and both banned
 * keywords are reported in it. That the audited JavaScript stays ignored is
 * pinned by eslint-config-ignores.spec.ts.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const UPSTREAM = 'src/renderer/features/reader/adapters/foliate/upstream';
const DECLARATION = `${UPSTREAM}/mobi.d.ts`;

/** The messages the flat config attaches to each banned keyword. */
const ANY_MESSAGE = 'Explicit `any` is not allowed.';
const UNKNOWN_MESSAGE = 'Explicit `unknown` is not allowed.';

/**
 * Both banned keywords in one probe, linted once at the declaration's own path
 * so the result reflects the configuration that file actually resolves rather
 * than a probe run from some unrelated directory.
 */
const PROBE_SOURCE = [
  'export type AnyProbe = { readonly value: any };',
  'export type UnknownProbe = { readonly value: unknown };',
  '',
].join('\n');

/**
 * The flat config is type-aware, so every `ESLint` instance builds its own
 * TypeScript project service — seconds of work that is repeated per instance
 * and per uncached lint call. One instance and one probe lint that work once,
 * in a shared setup, keeps this regression fast and deterministic when the rest
 * of the suite is competing for the same cores.
 */
const SETUP_TIMEOUT_MS = 20_000;

let declarationIgnored = false;
let probeMessages: readonly string[] = [];
let declarationMessages: readonly Linter.LintMessage[] = [];

/** The `no-restricted-syntax` messages a lint result reported. */
function restrictedSyntaxMessages(results: readonly ESLint.LintResult[]): readonly string[] {
  return results.flatMap((result) =>
    result.messages.filter((message) => message.ruleId === 'no-restricted-syntax').map((message) => message.message)
  );
}

beforeAll(async () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  declarationIgnored = await eslint.isPathIgnored(DECLARATION);
  probeMessages = restrictedSyntaxMessages(
    await eslint.lintText(PROBE_SOURCE, { filePath: resolve(REPO_ROOT, DECLARATION) })
  );
  declarationMessages = (await eslint.lintFiles([DECLARATION])).flatMap((result) => result.messages);
}, SETUP_TIMEOUT_MS);

describe('ambient declarations under the vendored foliate directory', () => {
  it('is linted rather than ignored', () => {
    expect(declarationIgnored).toBe(false);
  });

  it('reports an explicit any in an ambient declaration', () => {
    expect(probeMessages.join('\n')).toContain(ANY_MESSAGE);
  });

  it('reports an explicit unknown in an ambient declaration', () => {
    expect(probeMessages.join('\n')).toContain(UNKNOWN_MESSAGE);
  });

  it('accepts the declaration as it stands', () => {
    expect(declarationMessages).toEqual([]);
  });
});
