import { errnoCode } from '@shared/models/caught-error';
import type { UpdateErrorCode } from '@shared/schemas/updates';
import { UpdateVerificationError } from './update-manifest';
import { UpdateNetworkError, UpdateNotConfiguredError } from './signed-release-provider';

/**
 * Maps any failure from a check, download or install to one fixed, safe code
 * and message. Raw error text (URLs, file paths, stack traces, remote bodies)
 * never reaches the renderer: the message shown is always one of the strings
 * below, and the log records only the error's name and code.
 */

const MESSAGES: Readonly<Record<UpdateErrorCode, string>> = {
  offline: 'Could not reach the release server. Check your connection and try again.',
  'verification-failed': 'The update failed its authenticity or integrity check and was not used.',
  'not-configured': 'This build cannot verify updates, so it does not check for them.',
  'check-failed': 'Checking for updates failed. Try again later.',
  'download-failed': 'The update could not be downloaded. Try again.',
  'install-failed': 'The update could not be prepared for installation. Interleaf will keep running this version.',
};

const NETWORK_PATTERN = /\b(?:net::ERR_[A-Z_]+|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/;
const INTEGRITY_PATTERN = /\b(?:sha512 checksum mismatch|sha2 checksum mismatch|ERR_CHECKSUM_MISMATCH)\b/i;

const FALLBACK_CODES = { check: 'check-failed', download: 'download-failed', install: 'install-failed' } as const;

export function updateErrorMessage(code: UpdateErrorCode): string {
  return MESSAGES[code];
}

/** Call with `error instanceof Error ? error : null` from the catch site. */
export function classifyUpdateError(error: Error | null, stage: 'check' | 'download' | 'install'): UpdateErrorCode {
  if (error instanceof UpdateNotConfiguredError) return 'not-configured';
  if (error instanceof UpdateVerificationError) return 'verification-failed';
  if (error instanceof UpdateNetworkError) return 'offline';
  const text = error === null ? '' : `${error.name} ${error.message} ${errnoCode(error) ?? ''}`;
  if (INTEGRITY_PATTERN.test(text)) return 'verification-failed';
  if (stage !== 'install' && NETWORK_PATTERN.test(text)) return 'offline';
  return FALLBACK_CODES[stage];
}

/** Name and code only: enough to diagnose, never a URL, path or remote body. */
export function errorLogMeta(error: Error | null): { readonly name: string; readonly code: string | null } {
  if (error === null) return { name: 'unknown', code: null };
  return { name: error.name.slice(0, 64), code: errnoCode(error)?.slice(0, 64) ?? null };
}
