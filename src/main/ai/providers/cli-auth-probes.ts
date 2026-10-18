import type { AIProviderStatus } from '@shared/types/ai';
import type { Logger } from '../../logging/logger';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';
import { buildAllowlistedEnvironment, CLI_DIAGNOSTIC_MAX_BYTES } from './cli-runtime';
import type { CliExecFile } from './cli-process-types';

/**
 * Subscription status probes for the Codex and Claude Code CLIs. Each runs one
 * bounded status command and classifies its output; raw output never leaves
 * these functions.
 */
export async function detectCodexAuth(binary: string, executeFile: CliExecFile, log: Logger): Promise<AIProviderStatus['authentication']> {
  try {
    const result = await executeFile(binary, ['login', 'status'], {
      timeout: 5_000,
      maxBuffer: CLI_DIAGNOSTIC_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
      env: buildAllowlistedEnvironment(),
      windowsHide: true,
    });
    return parseCodexAuthStreams(result.stdout, result.stderr);
  } catch {
    // An auth probe failure is not evidence of a signed-out account. Keep the
    // state unknown so the UI cannot invite a misleading re-authentication
    // flow; the bounded main-process diagnostic records the probe failure.
    log.warn('Codex auth status probe failed', { providerId: 'codex', reason: 'probe-failed' });
    return 'unknown';
  }
}

/**
 * Codex 0.154 reports a successful `login status` on stderr and leaves stdout
 * empty; older builds report it on stdout. Each stream is classified on its
 * own and an empty stream carries no verdict, so diagnostic or conflicting
 * output beside a login line can only downgrade the result to `unknown` — it
 * can never grant authentication. Raw output stays in this function.
 */
export function parseCodexAuthStreams(stdout: string, stderr: string): AIProviderStatus['authentication'] {
  const verdicts = [stdout, stderr]
    .filter((stream) => stream.trim() !== '')
    .map((stream) => parseCodexAuthStatus(stream));
  const first = verdicts[0];
  if (first === undefined) return 'unknown';
  return verdicts.every((verdict) => verdict === first) ? first : 'unknown';
}

/** Parse only the ChatGPT subscription status, never arbitrary “logged in”. */
export function parseCodexAuthStatus(value: string): AIProviderStatus['authentication'] {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (normalized === 'logged in using chatgpt') return 'connected';
  if (normalized === 'not logged in' || normalized === 'logged out') return 'disconnected';
  return 'unknown';
}

export async function detectClaudeAuth(binary: string, executeFile: CliExecFile, log: Logger): Promise<AIProviderStatus['authentication']> {
  try {
    const result = await executeFile(binary, ['auth', 'status'], {
      timeout: 5_000,
      maxBuffer: CLI_DIAGNOSTIC_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
      env: buildAllowlistedEnvironment(),
      windowsHide: true,
    });
    return parseClaudeAuth(result.stdout);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
      return parseClaudeAuth(error.stdout);
    }
    log.warn('Claude auth status probe failed', { providerId: 'claude', reason: 'probe-failed' });
    return 'unknown';
  }
}

function parseClaudeAuth(value: string): AIProviderStatus['authentication'] {
  try {
    const parsed: PortableValue = parsePortableJson(value);
    if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed) {
      return parsed.loggedIn === true ? 'connected' : 'disconnected';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}
