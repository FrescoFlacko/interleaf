/**
 * Endpoint policy for the `local` Reader Chat provider.
 *
 * Interleaf will open a connection to a local inference server, and the only
 * property it can actually enforce about that server is *where the socket
 * goes*. So the policy is deliberately not "a URL the user says is local": it
 * is a literal loopback IP address, written out, with nothing else attached.
 *
 * That choice is what makes the invariant mechanical rather than argued. A
 * literal `127.0.0.1` or `[::1]` authority is resolved by no name server, so
 * there is no DNS answer to be poisoned and no second lookup to disagree with
 * the first — the rebinding class of attack has no step to attack. `localhost`
 * is rejected for exactly that reason: it is a name, it is resolved, and on a
 * misconfigured host it can resolve somewhere else entirely.
 *
 * Everything else a URL can carry is refused rather than ignored, because
 * ignoring it would mean the string the user reads and the request Interleaf
 * makes are not the same thing: credentials in the authority, a path, a query,
 * a fragment, `https` (a loopback server has no meaningful certificate and
 * accepting it would only invite a proxy in the middle). Request paths are
 * built by main from fixed constants against the canonical origin, never taken
 * from configuration.
 *
 * This module is portable by design — no Node, no Electron — so the settings
 * schema, the main-process transport, and tests all validate against one
 * definition instead of three that can drift.
 */

/** Ollama's documented default, and the value a fresh install starts from. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:11434';

/**
 * How Interleaf talks to whatever is listening.
 *
 * - `ollama` — an Ollama server. It speaks the OpenAI-compatible surface, and
 *   additionally publishes read-only native metadata Interleaf uses to learn a
 *   model's real context window instead of guessing one.
 * - `openai-compatible` — llama.cpp, LM Studio, or anything else serving
 *   `/v1/models` and `/v1/chat/completions`. Only that surface is used.
 */
export const LOCAL_ENDPOINT_MODES = ['ollama', 'openai-compatible'] as const;
export type LocalEndpointMode = (typeof LOCAL_ENDPOINT_MODES)[number];

/** Bounds the stored string before it is ever parsed. */
export const LOCAL_ENDPOINT_MAX_LENGTH = 128;

/**
 * The canonical form of an accepted endpoint: an origin and nothing else.
 *
 * `host`/`port` are carried separately because the transport connects by
 * address and port directly. It never re-parses `origin` and never performs a
 * name lookup.
 */
export type LoopbackEndpoint = {
  /** Exactly `http://<host>:<port>`, with no trailing slash. */
  readonly origin: string;
  /** Literal address for the socket: `127.0.0.1` or `::1` (no brackets). */
  readonly host: string;
  readonly port: number;
  /** IP version, so the transport can pin the address family. */
  readonly family: 4 | 6;
};

export type LoopbackEndpointRejection =
  | 'empty'
  | 'too-long'
  | 'malformed'
  | 'scheme'
  | 'credentials'
  | 'host'
  | 'port'
  | 'path';

export type LoopbackEndpointResult =
  | { readonly ok: true; readonly endpoint: LoopbackEndpoint }
  | { readonly ok: false; readonly reason: LoopbackEndpointRejection };

/** User-facing explanation for each rejection. Safe to render verbatim. */
export const LOOPBACK_ENDPOINT_MESSAGES: Readonly<Record<LoopbackEndpointRejection, string>> = {
  empty: 'Enter the address of your local server.',
  'too-long': 'That address is too long to be a local server address.',
  malformed: 'That is not a valid address. Use http://127.0.0.1:11434.',
  scheme: 'Use http:// — a loopback server is reached over plain HTTP.',
  credentials: 'Remove the username and password from the address.',
  host: 'Only 127.0.0.1 and [::1] are accepted. Names such as localhost, other machines, and LAN addresses are not.',
  port: 'Enter a port between 1 and 65535.',
  path: 'Enter only the server address, with no path, query, or #fragment.',
};

/**
 * Accept a saved endpoint, or say precisely why it was refused.
 *
 * The check runs once, in main, and produces the canonical value everything
 * downstream uses; no later stage re-derives an origin from user text.
 */
export function parseLoopbackEndpoint(value: string): LoopbackEndpointResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > LOCAL_ENDPOINT_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  // Control characters never appear in a legitimate address, and a stray CR or
  // LF is the classic way to try to graft extra headers onto a request.
  if (/[\u0000-\u0020\u007f]/u.test(trimmed)) return { ok: false, reason: 'malformed' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  // A bare origin is what is stored, so `/` (which `new URL` supplies) is the
  // only pathname allowed. Anything else is user-supplied routing, and request
  // paths are main's to construct.
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'path' };
  }

  // `URL` normalizes an IPv6 authority into bracketed lowercase hex, so `[::1]`
  // and `[0:0:0:0:0:0:0:1]` arrive here in the same shape and are compared as
  // one value rather than as text the user happened to type.
  const hostname = url.hostname;
  const family: 4 | 6 | null = hostname === '127.0.0.1' ? 4 : hostname === '[::1]' ? 6 : null;
  if (family === null) return { ok: false, reason: 'host' };

  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, reason: 'port' };

  return {
    ok: true,
    endpoint: {
      origin: `http://${hostname}:${String(port)}`,
      // The socket wants a bare address; brackets are URL syntax, not part of it.
      host: family === 6 ? '::1' : '127.0.0.1',
      port,
      family,
    },
  };
}

/** Convenience predicate for schema-level validation. */
export function isLoopbackEndpoint(value: string): boolean {
  return parseLoopbackEndpoint(value).ok;
}
