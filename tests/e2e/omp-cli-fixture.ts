import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An offline stand-in for the `omp` CLI, so a test can see the composer row the
 * reader reported: a short provider name beside a long model name.
 *
 * The reported misalignment is specific to that combination — "Omp" next to
 * "Gemini 3.8 Flash" — and neither half of it can be staged from the renderer.
 * `Omp` is a CLI provider, discovered by running the binary the app finds on
 * `PATH`, and its model list is whatever that binary prints. So the fixture is
 * the binary: a script that answers the two probes the provider makes and
 * nothing else.
 *
 * It reaches no network and bills nothing. It also refuses to chat, which is
 * deliberate — this is a layout fixture, and a test that tried to send a turn
 * through it should fail rather than quietly appear to work.
 */

/** Selectors follow Omp's documented `provider/model` form. */
const CATALOG = {
  models: [
    { selector: 'google/gemini-3.8-flash', provider: 'google', name: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxTokens: 64_000 },
    { selector: 'openai/gpt-5-mini', provider: 'openai', name: 'GPT-5 Mini', contextWindow: 400_000, maxTokens: 32_000 },
    { selector: 'anthropic/claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5', contextWindow: 200_000, maxTokens: 32_000 },
  ],
} as const;

/** The model the composer should end up showing. */
export const OMP_FIXTURE_MODEL_NAME = 'Gemini 3.8 Flash';

/**
 * Writes the fixture CLI into a fresh temporary directory and returns that
 * directory, ready to be handed to `launchInterleaf({ binDir })`.
 */
export function createOmpCliFixture(): string {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-omp-fixture-'));
  mkdirSync(binDir, { recursive: true });
  const script = [
    '#!/bin/sh',
    '# Offline fixture for the `omp` CLI: version and model catalog only.',
    'case "$1" in',
    '  --version) echo "omp 0.0.0-e2e-fixture" ;;',
    `  models) cat <<'OMP_CATALOG_EOF'`,
    JSON.stringify(CATALOG),
    'OMP_CATALOG_EOF',
    '    ;;',
    '  *) echo "unsupported in fixture: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  const binary = path.join(binDir, 'omp');
  writeFileSync(binary, script, 'utf8');
  chmodSync(binary, 0o755);
  return binDir;
}
