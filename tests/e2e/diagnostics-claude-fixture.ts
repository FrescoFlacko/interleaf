import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DiagnosticsClaudeFixture = {
  /** Prepend to the sanitized `PATH` via `launchInterleaf({ binDir })`. */
  readonly binDir: string;
  /** Switches what `claude auth status` reports from the next probe on. */
  readonly signIn: () => void;
  /** Each invocation as `kind [arg1][arg2]…`, where kind is probe, listing or chat. */
  readonly invocations: () => readonly string[];
  /** Invocations that asked the CLI to answer a prompt. */
  readonly chatInvocations: () => readonly string[];
  /** The stdin each chat invocation received, in order. */
  readonly chatPrompts: () => readonly string[];
};

/**
 * An offline `claude` binary for diagnostics analysis through the real CLI
 * adapter: no network, no model, no production fake.
 *
 * It answers the read-only probes the app really sends — `--version`, the
 * agent detector's `--help`, and `auth status`, whose JSON verdict starts signed out until the spec signs it
 * in — and refuses the model listing (`--bare`), so the provider keeps its
 * default model. A `-p` turn records its argv and its whole stdin, then
 * replies with Claude's partial-message stream: one text delta per line of
 * `answer`.
 *
 * The provider spawns CLIs with an allowlisted environment, so the ledger
 * paths are written into the script rather than passed in variables.
 */
export function createDiagnosticsClaudeFixture(answer: readonly string[]): DiagnosticsClaudeFixture {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-diagnostics-claude-fixture-'));
  const ledger = path.join(binDir, 'invocations.log');
  const state = path.join(binDir, 'auth-state');
  const prompts = path.join(binDir, 'prompts');
  const events = answer.map((text, index) => JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: index < answer.length - 1 ? `${text}\n` : text } },
  }));
  for (const line of events) if (line.includes("'")) throw new Error('fixture answer lines must not contain single quotes');
  const record = (kind: string): string => `printf '${kind} ' >> ${JSON.stringify(ledger)}; printf '[%s]' "$@" >> ${JSON.stringify(ledger)}; echo >> ${JSON.stringify(ledger)}`;
  const script = [
    '#!/bin/sh',
    '# Offline fixture for the `claude` CLI used by the diagnostics E2E.',
    'case "$1" in',
    `  --version) ${record('probe')}; echo "2.1.0 (Claude Code e2e fixture)"; exit 0 ;;`,
    `  --help) ${record('probe')}; echo "Usage: claude [options]"; exit 0 ;;`,
    `  auth) ${record('probe')}`,
    `    if [ "$(cat ${JSON.stringify(state)})" = "signed-in" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi`,
    '    exit 0 ;;',
    '  -p)',
    `    case " $* " in *" --bare "*) ${record('listing')}; exit 1 ;; esac`,
    `    ${record('chat')}`,
    `    n=$(ls ${JSON.stringify(prompts)} | wc -l | tr -d ' ')`,
    `    cat > ${JSON.stringify(prompts)}/prompt-$n.txt`,
    ...events.map((line) => `    printf '%s\\n' '${line}'`),
    '    exit 0 ;;',
    'esac',
    record('refused'),
    'echo "the offline fixture does not support this invocation" >&2',
    'exit 1',
    '',
  ].join('\n');
  const file = path.join(binDir, 'claude');
  writeFileSync(file, script, 'utf8');
  writeFileSync(ledger, '', 'utf8');
  writeFileSync(state, 'signed-out', 'utf8');
  mkdirSync(prompts);
  chmodSync(file, 0o755);

  const invocations = (): readonly string[] =>
    readFileSync(ledger, 'utf8').split('\n').filter((line) => line !== '');

  return {
    binDir,
    signIn: () => { writeFileSync(state, 'signed-in', 'utf8'); },
    invocations,
    chatInvocations: () => invocations().filter((line) => line.startsWith('chat ')),
    chatPrompts: () => readdirSync(prompts).sort().map((name) => readFileSync(path.join(prompts, name), 'utf8')),
  };
}

