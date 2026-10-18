/**
 * Primitives shared by the CLI chat transport and the per-CLI adapters it
 * composes.
 *
 * They live in their own module so an adapter (for example the Pi adapter) can
 * use the same environment allowlist and chunking rule as the transport
 * without importing the module that assembles it.
 */

import { CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS } from '@shared/constants/chat-wire';
import { buildCliSearchPath } from '../../app/cli-search-path';

/** Upper bound, in bytes, for any bounded CLI diagnostic or probe capture. */
export const CLI_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

/**
 * Child processes never inherit the main process environment: a document, a
 * model, or an external CLI must not be able to read application secrets that
 * happen to be exported to Interleaf. PATH is the inherited PATH plus the
 * well-known CLI install locations a Finder-launched macOS app lacks.
 */
export function buildAllowlistedEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TERM', 'SystemRoot', 'WINDIR',
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = key === 'PATH' ? buildCliSearchPath() : process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export const MAX_SCHEMA_CHUNK_UNITS = CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS;

/** Split provider text into IPC-schema-safe chunks without losing content. */
export function splitToSafeChunks(text: string, maxUnits = MAX_SCHEMA_CHUNK_UNITS): readonly string[] {
  if (!Number.isSafeInteger(maxUnits) || maxUnits <= 0) {
    throw new RangeError('Chunk size must be a positive safe integer.');
  }
  if (text.length <= maxUnits) {
    return text.length > 0 ? [text] : [];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxUnits) {
    chunks.push(text.slice(i, i + maxUnits));
  }
  return chunks;
}
