import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An offline stand-in for an agent-profile CLI.
 *
 * Agent profiles are detected by a `PATH` lookup followed by bounded
 * `--version` and `--help` probes, and the suite runs with a sanitized `PATH`
 * that can reach no real CLI (see `offline-environment.ts`). A spec that needs
 * the application to consider a profile *installed* — because what it is
 * showing is the view a reader gets when it is — supplies the binary itself.
 *
 * It answers the two probes and refuses everything else, loudly. Running an
 * agent is not something a fixture can stand in for, and a spec that tried
 * would fail on the refusal rather than appear to have run an agent.
 */
export function createAgentCliFixture(binary: string): string {
  const binDir = mkdtempSync(path.join(os.tmpdir(), `interleaf-${binary}-fixture-`));
  const script = [
    '#!/bin/sh',
    `# Offline fixture for the \`${binary}\` CLI: detection probes only.`,
    'case "$1" in',
    `  --version) echo "${binary} 0.0.0-e2e-fixture" ;;`,
    `  --help) echo "usage: ${binary} [--version] [--help]" ;;`,
    '  *) echo "unsupported in fixture: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  const file = path.join(binDir, binary);
  writeFileSync(file, script, 'utf8');
  chmodSync(file, 0o755);
  return binDir;
}
