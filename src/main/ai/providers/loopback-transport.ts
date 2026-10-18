/**
 * The only way Interleaf talks to a local inference server.
 *
 * This is deliberately `node:http` and not `fetch`. Three properties that the
 * `local` provider's security claim rests on are structural here, rather than
 * options that must be remembered at every call site:
 *
 * 1. **No proxy.** Node's HTTP client has no notion of `HTTP_PROXY`; it
 *    connects to the address it is given. Undici — the engine behind `fetch` —
 *    can be steered by a global dispatcher another part of the process
 *    installs, and then a request addressed to `127.0.0.1` leaves the machine.
 * 2. **No redirects.** `http.request` returns the 302; it does not chase it.
 *    There is no "follow" mode to leave switched on by accident, so a local
 *    server cannot bounce Interleaf — carrying its prompt — to a remote host.
 * 3. **No name resolution.** The endpoint policy admits only literal loopback
 *    addresses, so the socket layer never performs a lookup. The `lookup` hook
 *    below is installed anyway and always fails: if a non-literal host ever
 *    reaches this transport through some future path, it cannot resolve, so
 *    DNS-rebinding has no step to attack rather than merely being unlikely.
 *
 * Everything read here is untrusted: a local server is a separate program,
 * possibly one the user installed today, and it is bounded in bytes, lines,
 * and time exactly as a remote one would be.
 */
import type { LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent } from 'node:http';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { LoopbackEndpoint } from '@shared/schemas/local-endpoint';

/** Time allowed to establish the TCP connection to the local server. */
const LOOPBACK_CONNECT_TIMEOUT_MS = 3_000;
/** Time allowed between bytes once the server has started answering. */
const LOOPBACK_IDLE_TIMEOUT_MS = 60_000;
/** Ceiling on a metadata request: catalogs and probes are small and fast. */
const LOOPBACK_REQUEST_TIMEOUT_MS = 15_000;
/** Ceiling on one streamed chat turn, however lively the stream stays. */
const LOOPBACK_STREAM_TIMEOUT_MS = 5 * 60 * 1_000;
/** Bytes accepted from a metadata response before it is abandoned. */
const LOOPBACK_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Bytes accepted across one streamed turn. */
const LOOPBACK_MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** Lines accepted from one stream; SSE sends two per chunk plus blanks. */
const LOOPBACK_MAX_STREAM_LINES = 200_000;
/**
 * Longest single line accepted, in bytes.
 *
 * Bytes rather than characters because the bound has to hold while raw chunks
 * are still arriving, before the line is complete enough to decode. A
 * well-formed SSE data line is far shorter than this either way.
 */
export const LOOPBACK_MAX_LINE_LENGTH = 256 * 1024;

/**
 * A private agent, so no pooled connection is ever shared with — or inherited
 * from — anything else in the process. `keepAlive: false` means each turn opens
 * and closes its own socket, which costs nothing over loopback and leaves no
 * idle connection to a user-installed server sitting open.
 */
const loopbackAgent = new Agent({ keepAlive: false, maxSockets: 8 });

/**
 * Refuses every name lookup. Reached only if a non-literal host somehow arrives
 * here, in which case failing is the correct outcome.
 */
const refuseLookup: LookupFunction = (_hostname, _options, callback) => {
  callback(new Error('loopback-transport-lookup-refused'), '', 4);
};

/** Paths this transport may request, fixed and app-owned. */
type LoopbackPath = string & { readonly __loopbackPath?: never };

export type LoopbackRequestOptions = {
  readonly endpoint: LoopbackEndpoint;
  /**
   * A fixed, app-owned absolute path. Never user configuration: the endpoint
   * policy rejects a path component precisely so this stays the only source of
   * one.
   */
  readonly path: LoopbackPath;
  readonly method: 'GET' | 'POST';
  /** JSON request body, already serialized by the caller. */
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * Deadline overrides for the connect and post-header-idle phases.
   *
   * Main-side call-site options, never renderer input: the endpoint policy and
   * the fixed paths are what bound this transport's reach, not these numbers.
   * They exist so a test can prove the idle deadline actually fires without
   * holding a socket open for a minute, which is the only way to make that
   * behaviour a regression test rather than a claim.
   */
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
};

export type LoopbackResponse = {
  readonly status: number;
  readonly body: string;
};

/**
 * Perform one bounded request and read the whole response.
 *
 * Used for read-only metadata: model catalogs and connection probes. It never
 * starts inference.
 */
export async function loopbackRequest(options: LoopbackRequestOptions): Promise<LoopbackResponse> {
  const maxBytes = options.maxBytes ?? LOOPBACK_MAX_RESPONSE_BYTES;
  const connection = await openLoopbackResponse(options, options.timeoutMs ?? LOOPBACK_REQUEST_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of readLoopbackChunks(connection)) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new InterleafError('validation', 'The local server sent more data than Interleaf accepts.');
      }
      chunks.push(chunk);
    }
    // Concatenated before decoding, so a multi-byte character split across two
    // TCP chunks is decoded once from whole bytes rather than twice from halves.
    return { status: connection.response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    connection.dispose();
  }
}

export type LoopbackStreamOptions = Omit<LoopbackRequestOptions, 'maxBytes'> & {
  readonly maxBytes?: number;
  readonly maxLines?: number;
};

/**
 * Stream one response as lines.
 *
 * Lines rather than raw chunks because both surfaces this serves — SSE and
 * Ollama's newline-delimited JSON — are line-oriented, and doing the framing
 * once here means the bounds on line length, line count and total bytes are
 * enforced in one place instead of in each parser.
 *
 * The framing is done over raw bytes rather than by `readline` so that the
 * bounds hold *while* the body arrives. A server that sends megabytes without
 * ever sending a newline gives a line-oriented reader nothing to check, so the
 * caps would only be tested on data already accepted; here every chunk is
 * counted as it lands, and a pending line that grows past the cap is refused
 * before its terminator ever arrives.
 *
 * A non-2xx status is raised before any line is yielded, so an error page is
 * never mistaken for a stream.
 */
export async function* loopbackStreamLines(options: LoopbackStreamOptions): AsyncGenerator<string> {
  const maxBytes = options.maxBytes ?? LOOPBACK_MAX_STREAM_BYTES;
  const maxLines = options.maxLines ?? LOOPBACK_MAX_STREAM_LINES;
  const connection = await openLoopbackResponse(options, options.timeoutMs ?? LOOPBACK_STREAM_TIMEOUT_MS);
  try {
    const status = connection.response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw new InterleafError('internal', describeLoopbackStatus(status));
    }
    let bytes = 0;
    let lines = 0;
    let pending = Buffer.alloc(0);
    for await (const chunk of readLoopbackChunks(connection)) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new InterleafError('validation', 'The local server sent more data than Interleaf accepts.');
      }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const breakAt = pending.indexOf(0x0a);
        if (breakAt === -1) break;
        // The per-line cap has to be applied to the finished line here, before
        // it is decoded: a line that arrives whole inside a single chunk never
        // leaves anything over-long in `pending`, so the check after this loop
        // would never see it.
        if (breakAt > LOOPBACK_MAX_LINE_LENGTH) {
          throw new InterleafError('validation', 'The local server sent a malformed response.');
        }
        // A complete line is a complete byte sequence — no UTF-8 sequence can
        // contain a newline byte — so decoding it whole cannot split a
        // character, however the chunks happened to be cut.
        const line = decodeLine(pending.subarray(0, breakAt));
        pending = pending.subarray(breakAt + 1);
        lines += 1;
        if (lines > maxLines) {
          throw new InterleafError('validation', 'The local server sent more data than Interleaf accepts.');
        }
        yield line;
      }
      if (pending.length > LOOPBACK_MAX_LINE_LENGTH) {
        throw new InterleafError('validation', 'The local server sent a malformed response.');
      }
    }
    // Whatever arrived after the last newline is still a line; a server that
    // ends its stream without a trailing terminator has not sent a partial one.
    // It spends line budget like any other, so exceeding the cap on the last
    // line is refused rather than quietly dropped.
    if (pending.length > 0) {
      lines += 1;
      if (lines > maxLines) {
        throw new InterleafError('validation', 'The local server sent more data than Interleaf accepts.');
      }
      yield decodeLine(pending);
    }
  } finally {
    connection.dispose();
  }
}

/** Strip the CR of a CRLF pair, then decode. */
function decodeLine(raw: Buffer): string {
  const end = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length;
  return raw.subarray(0, end).toString('utf8');
}

/**
 * The response body, chunk by chunk, racing every read against the transport's
 * own failure.
 *
 * Destroying a socket does not end a pending `next()`; it leaves it pending. So
 * a stalled body, a cancelled turn, or an expired deadline has to be delivered
 * to the consumer as a rejection rather than left to the stream to notice,
 * which is what `connection.failure` is for. Without this race, a body that
 * stops mid-stream would hang the caller for as long as the server cared to
 * hold the socket open.
 */
async function* readLoopbackChunks(connection: LoopbackConnection): AsyncGenerator<Buffer> {
  const iterator = (connection.response as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([iterator.next(), connection.failure]);
    if (next.done === true) return;
    yield next.value;
  }
}

type LoopbackConnection = {
  readonly response: IncomingMessage;
  /**
   * Rejects with a typed safe error the moment the transport terminates for any
   * reason — abort, idle deadline, overall deadline, socket error — and never
   * settles otherwise. Pre-marked handled, so a deadline that expires just
   * after a caller finished cannot surface as an unhandled rejection.
   */
  readonly failure: Promise<never>;
  readonly dispose: () => void;
};

/**
 * Open the request and hand back the response together with the one function
 * that tears everything down — timers, listeners, and the socket — whether the
 * caller finished, threw, or abandoned the iterator part-way through.
 *
 * Settling the response promise and terminating the transport are deliberately
 * two different things. Headers arriving only means the caller can start
 * reading; every deadline stays armed behind them, because the failure this
 * bounds — a server that answers `200 OK` and then goes quiet forever — happens
 * entirely after the headers. Node's socket timeout notifies but does not close,
 * so termination is performed here rather than assumed.
 */
function openLoopbackResponse(
  options: LoopbackRequestOptions,
  overallTimeoutMs: number,
): Promise<LoopbackConnection> {
  const connectTimeoutMs = options.connectTimeoutMs ?? LOOPBACK_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? LOOPBACK_IDLE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    /** Headers arrived and the caller now owns the response. */
    let opened = false;
    /** The socket, timers and listeners are gone; nothing may fire again. */
    let terminated = false;
    let response: IncomingMessage | null = null;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body, 'utf8'));
    }

    const client = httpRequest({
      protocol: 'http:',
      host: options.endpoint.host,
      port: options.endpoint.port,
      family: options.endpoint.family,
      path: options.path,
      method: options.method,
      headers,
      agent: loopbackAgent,
      lookup: refuseLookup,
      // Bounds the connect phase specifically; the idle timeout below governs
      // the connection once it is established.
      timeout: connectTimeoutMs,
      // Node would otherwise chase a `location` header only if asked to; it is
      // stated here so the absence of redirect-following is not accidental.
      setHost: true,
    });

    let rejectFailure: (error: InterleafError) => void = () => undefined;
    const failure = new Promise<never>((_resolve, rejectPromise) => { rejectFailure = rejectPromise; });
    failure.catch(() => { /* raced by the active consumer, if there still is one */ });

    const cleanup = (): void => {
      clearTimeout(overall);
      options.signal?.removeEventListener('abort', onAbort);
    };

    /**
     * The one way this transport ends: before or after headers, on success or
     * on failure. Everything that can go wrong routes through here, so there is
     * a single place where the socket is actually closed and a single typed
     * error reaches whoever is still waiting.
     */
    const terminate = (error: InterleafError): void => {
      if (terminated) return;
      terminated = true;
      cleanup();
      response?.destroy();
      client.destroy();
      // Wakes a consumer parked on the body. Harmless once one has finished.
      rejectFailure(error);
      // Before headers there is no consumer yet, so the open itself fails.
      if (!opened) reject(error);
    };

    // Node reports request and socket failures as errno exceptions, which is
    // where the `ECONNREFUSED` this path acts on actually lives.
    const fail = (error: NodeJS.ErrnoException): void => {
      terminate(error instanceof InterleafError ? error : toLoopbackError(error));
    };

    const overall = setTimeout(() => {
      terminate(new InterleafError('internal', 'The local server did not finish responding in time.'));
    }, overallTimeoutMs);
    overall.unref();

    const onAbort = (): void => {
      terminate(new InterleafError('internal', 'The local request was cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    /**
     * Which deadline just expired.
     *
     * Node raises the same `timeout` event on the socket and on the request
     * whichever phase the connection is in, so the phase has to be tracked
     * here. Reporting an idle body as "did not accept a connection" would send
     * a user to check whether their server is running when it plainly is.
     */
    let connected = false;
    const onInactivity = (): void => {
      // Node reports inactivity and leaves the socket open; closing it is this
      // transport's job, and `terminate` is where that happens.
      terminate(connected
        ? new InterleafError('internal', 'The local server stopped responding.')
        : new InterleafError('internal', 'The local server did not accept a connection in time.'));
    };

    client.on('socket', (socket) => {
      // Replaces the connect deadline with an inactivity deadline once bytes
      // start moving, so a long but healthy stream is not cut off while a
      // silent one still is. This deadline stays armed for the whole body.
      socket.setTimeout(connectTimeoutMs);
      socket.once('connect', () => {
        connected = true;
        socket.setTimeout(idleTimeoutMs);
      });
      socket.on('timeout', onInactivity);
    });

    client.on('error', fail);
    client.on('timeout', onInactivity);

    // Checked only once every listener is attached: `terminate` destroys the
    // request, and a destroyed request with no `error` handler is an unhandled
    // exception rather than a cancelled call.
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    client.on('response', (incoming) => {
      if (terminated) {
        incoming.destroy();
        return;
      }
      response = incoming;
      opened = true;
      resolve({
        response: incoming,
        failure,
        dispose: () => { terminate(new InterleafError('internal', 'The local request ended.')); },
      });
    });

    if (options.body !== undefined) client.write(options.body, 'utf8');
    client.end();
  });
}

/**
 * Turn a socket-level failure into a message that helps without describing the
 * user's machine. `ECONNREFUSED` is the one worth naming precisely: it almost
 * always means the server simply is not running, which the user can fix.
 */
function toLoopbackError(error: NodeJS.ErrnoException): InterleafError {
  if (error.code === 'ECONNREFUSED') {
    return new InterleafError('internal', 'No local server is listening at that address.');
  }
  return new InterleafError('internal', 'Interleaf could not reach the local server.');
}

/** Status-code wording that never echoes a body the local server controls. */
export function describeLoopbackStatus(status: number): string {
  if (status === 404) return 'The local server does not offer that API. Check the endpoint mode.';
  if (status === 401 || status === 403) return 'The local server refused the request.';
  return `The local server returned status ${String(status)}.`;
}
