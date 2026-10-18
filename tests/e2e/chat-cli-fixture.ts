import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ChatCliFixture = {
  /** Prepend to the sanitized `PATH` via `launchInterleaf({ binDir })`. */
  readonly binDir: string;
  /** Every argv this fixture was invoked with, in order. */
  readonly invocations: () => readonly string[];
  /** Argv lines that asked the CLI to answer a turn rather than identify itself. */
  readonly chatInvocations: () => readonly string[];
};

/** One `model/list` entry, in the shape `codex app-server` answers with. */
export type CodexListedModel = {
  readonly model: string;
  readonly isDefault?: boolean;
  readonly supportedReasoningEfforts?: readonly { readonly reasoningEffort: string }[];
};

/** Argv the provider sends to identify the CLI or list its models, never to run a turn. */
const PROBE_PREFIXES = ['--version', '--help', 'app-server '];

function isProbe(line: string): boolean {
  return line === 'login status' || PROBE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * The `app-server` model-listing case, when the fixture lists models. Both
 * request frames are read before answering, as the real server does; exiting
 * first would break the pipe main is still writing to.
 */
function listingCase(models: readonly CodexListedModel[] | undefined): readonly string[] {
  if (models === undefined) return [];
  // JSON has no single quotes to escape, so the frame is a literal shell word.
  const listing = JSON.stringify({ id: 2, result: { data: models } });
  return [`  "app-server --listen") head -n 2 >/dev/null; printf '%s\\n' '${listing}'; exit 0 ;;`];
}

/**
 * A `codex` binary that detects as a connected chat provider and answers
 * nothing.
 *
 * The provider-routing specs need a *rival*: with the suite offline, OpenRouter
 * is the only provider a session can bind to, so binding it proves nothing. A
 * connected CLI provider is the one the registry offers first, so it is what a
 * session silently binds to when an explicit choice is dropped — the defect
 * these specs exist for.
 *
 * Detection is answered the way the real probes ask for it: `--version`, then
 * `login status`, whose one recognized phrase is what the provider reads as a
 * connected ChatGPT subscription. Everything else — every argv that would
 * actually run a turn — is recorded and refused, so a wrong binding shows up as
 * a line in the ledger rather than as a plausible-looking answer.
 *
 * `delayMs` holds the detection probes open. Provider discovery then lands
 * after the panel is on screen, which is the state the race happens in: a
 * reader choosing while the app is still deciding what it has.
 *
 * `models` answers the `app-server` model listing, which is where main reads
 * each model's reasoning levels; without it the listing fails like any other
 * unsupported argv and the provider keeps only its default model.
 */
export function createChatCliFixture(options?: { readonly delayMs?: number; readonly models?: readonly CodexListedModel[] }): ChatCliFixture {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-codex-chat-fixture-'));
  const ledger = path.join(binDir, 'invocations.log');
  const delay = options?.delayMs ?? 0;
  // The provider spawns CLIs with a minimal allowlisted environment, so the
  // ledger path cannot be passed in an environment variable. It is written into
  // the script, which is created per test run in its own directory.
  const script = [
    '#!/bin/sh',
    '# Offline fixture for the `codex` CLI: detection only, never inference.',
    `printf '%s\\n' "$*" >> ${JSON.stringify(ledger)}`,
    ...(delay > 0 ? [`sleep ${(delay / 1000).toFixed(3)}`] : []),
    'case "$1 $2" in',
    '  "--version "*) echo "codex-cli 0.0.0-e2e-fixture"; exit 0 ;;',
    '  "login status") echo "Logged in using ChatGPT"; exit 0 ;;',
    ...listingCase(options?.models),
    'esac',
    'case "$1" in',
    '  --help) echo "usage: codex [--version] [login status]"; exit 0 ;;',
    'esac',
    'echo "the offline fixture does not run agents or answer turns: $*" >&2',
    'exit 1',
    '',
  ].join('\n');
  const file = path.join(binDir, 'codex');
  writeFileSync(file, script, 'utf8');
  writeFileSync(ledger, '', 'utf8');
  chmodSync(file, 0o755);

  const invocations = (): readonly string[] =>
    readFileSync(ledger, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

  return {
    binDir,
    invocations,
    chatInvocations: () => invocations().filter((line) => !isProbe(line)),
  };
}
