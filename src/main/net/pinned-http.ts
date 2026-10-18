import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { InterleafError } from '@shared/errors/interleaf-error';
import { assertAllowedAddress, type ValidatedRequestUrl } from './address-policy';
import { toError } from '@shared/models/caught-error';

/**
 * One bounded, address-pinned HTTP hop.
 *
 * This is the single place Interleaf opens a socket to an attacker-chosen host,
 * and both outbound users — the article HTML fetcher and the article media
 * fetcher — go through it, so the SSRF-relevant behaviour exists once:
 *
 * - DNS is resolved once per hop by this class, *every* returned address is
 *   validated against the address policy, and the chosen address is pinned onto
 *   the connection through the socket-level `lookup` hook. The name is never
 *   resolved a second time, so a rebinding resolver cannot swap in a private
 *   address between the check and the connect. TLS still verifies against the
 *   hostname, not the pin.
 * - Wire bytes, declared content length, socket idle time, and the caller's
 *   wall-clock deadline are all bounded, and the response is destroyed the
 *   moment a bound is crossed rather than after the body finishes.
 * - No cookie, authorization, or referrer header is ever sent, and no response
 *   cookie is stored: every request is unauthenticated and stateless.
 * - The connection is made by `node:http`/`node:https` over agents this class
 *   owns. Neither honours `HTTP_PROXY` and friends, and `globalAgent` is never
 *   used, so no environment variable can route a validated request through an
 *   unvalidated hop — which is also what keeps the pinned address meaningful.
 *   Switching this to `fetch`/undici would silently reintroduce proxy support.
 *
 * Redirect *following* is deliberately not here. The caller re-validates each
 * `Location` from scratch through `assertRequestUrl` and asks for another hop,
 * so no partially-validated URL is ever reachable from inside this class.
 *
 * `lookupAddresses` and `requestFactory` exist so tests can drive every branch
 * deterministically without contacting a real host. They do not relax any check
 * — the policy above runs identically whichever transport is injected.
 */

const SOCKET_IDLE_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

const REDIRECT_STATUS_CODES: Record<number, true> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

export type ResolvedAddress = { readonly address: string; readonly family: number };

export type AddressResolver = (
  hostname: string,
  timeoutMs?: number
) => Promise<readonly ResolvedAddress[]>;

/**
 * The part of an outbound request this client drives: the three outcomes it
 * listens for, sending, and tearing it down. A Node `ClientRequest` answers
 * this, and so can a scripted transport, so neither the client nor a test
 * depends on the rest of Node's request surface.
 */
type PinnedRequest = {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'timeout', listener: () => void): void;
  on(event: 'response', listener: (response: IncomingMessage) => void): void;
  end(): void;
  destroy(): void;
};

export type RequestFactory = (url: URL, options: RequestOptions) => PinnedRequest;

export type PinnedHopResult =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'body'; readonly body: Buffer; readonly response: IncomingMessage };

export type PinnedHttpClientOptions = {
  readonly lookupAddresses?: AddressResolver;
  readonly requestFactory?: RequestFactory;
  /** Sent verbatim as the `Accept` header. */
  readonly accept: string;
  readonly acceptEncoding: string;
  readonly userAgent: string;
  readonly maxTransferBytes: number;
  /**
   * Content-type or other header admission for a 2xx response, run before a
   * single body byte is buffered. Throwing here destroys the response.
   */
  readonly validateResponse: (response: IncomingMessage) => void;
};

/**
 * Wire-byte accounting for one logical fetch.
 *
 * A caller that is spending from a shared allowance passes one of these in, and
 * bytes are charged against it *as they arrive*, across every hop of a redirect
 * chain. Two things follow. The response is cut off at the caller's own
 * remaining allowance rather than at the client's per-file ceiling, so an
 * article with 2 MB of budget left cannot pull an 8 MB body. And the count
 * survives failure, so a request abandoned for being oversized still costs what
 * it actually moved instead of being refunded in full and retried by the next
 * image in the queue.
 */
export class TransferBudget {
  readonly limit: number;
  private used = 0;

  constructor(limit: number) {
    this.limit = Math.max(0, limit);
  }

  /** Wire bytes charged so far, whether or not the fetch succeeded. */
  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Charges arriving bytes, answering false once the allowance is passed. */
  charge(count: number): boolean {
    this.used += count;
    return this.used <= this.limit;
  }
}

export function failNetwork(message: string): never {
  throw new InterleafError('validation', message);
}

export function timedOut(): never {
  failNetwork('That page took too long to respond, so Interleaf stopped waiting.');
}

export function headerValue(response: IncomingMessage, name: string): string {
  const raw = response.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return typeof raw === 'string' ? raw : '';
}

function defaultResolver(
  hostname: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<readonly ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(
        new InterleafError(
          'validation',
          'That page took too long to respond, so Interleaf stopped waiting.'
        )
      );
    }, Math.max(timeoutMs, 1));
    timer.unref();

    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        reject(new InterleafError('validation', 'Interleaf could not find that website.'));
        return;
      }
      resolve(addresses.map((entry) => ({ address: entry.address, family: entry.family })));
    });
  });
}

function defaultRequestFactory(url: URL, options: RequestOptions): PinnedRequest {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return send(options);
}

type Settler = {
  resolveOnce(value: PinnedHopResult): void;
  rejectOnce(error: Error): void;
  onDone(callback: () => void): void;
};

/**
 * Guarantees a single settlement and one cleanup pass. Streams emit `error`,
 * `end`, and `timeout` in orders that depend on the peer, so the first outcome
 * wins and every later event — including one from a destroyed socket — is
 * dropped instead of racing the result.
 */
function createSettler(
  request: PinnedRequest,
  resolve: (value: PinnedHopResult) => void,
  reject: (error: Error) => void
): Settler {
  let settled = false;
  const cleanups: (() => void)[] = [];
  const finish = (): void => {
    settled = true;
    for (const cleanup of cleanups) cleanup();
  };
  return {
    resolveOnce(value) {
      if (settled) return;
      finish();
      resolve(value);
    },
    rejectOnce(error) {
      if (settled) return;
      finish();
      request.destroy();
      reject(error);
    },
    onDone(callback) {
      cleanups.push(callback);
    },
  };
}

export class PinnedHttpClient {
  private readonly resolveAddresses: AddressResolver;
  private readonly createRequest: RequestFactory;
  private readonly options: PinnedHttpClientOptions;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(options: PinnedHttpClientOptions) {
    this.options = options;
    this.resolveAddresses = options.lookupAddresses ?? defaultResolver;
    this.createRequest = options.requestFactory ?? defaultRequestFactory;
    this.httpAgent = new HttpAgent({
      keepAlive: false,
      maxSockets: 4,
      timeout: SOCKET_IDLE_TIMEOUT_MS,
    });
    this.httpsAgent = new HttpsAgent({
      keepAlive: false,
      maxSockets: 4,
      timeout: SOCKET_IDLE_TIMEOUT_MS,
    });
  }

  /**
   * Performs one hop, charging its wire bytes to `budget` when one is supplied.
   *
   * Without a budget the hop is bounded by the client's own per-file ceiling,
   * which is what the page fetcher wants: it has exactly one response to read.
   */
  async performHop(
    target: ValidatedRequestUrl,
    deadline: number,
    signal?: AbortSignal,
    budget?: TransferBudget
  ): Promise<PinnedHopResult> {
    if (signal?.aborted) timedOut();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) timedOut();
    const transfer = budget ?? new TransferBudget(this.options.maxTransferBytes);
    const pinned = await this.pinAddress(target, remainingMs, signal);
    const requestOptions = this.buildRequestOptions(target, pinned, remainingMs);
    return await this.sendRequest(target.url, requestOptions, deadline, signal, transfer);
  }

  private async pinAddress(
    target: ValidatedRequestUrl,
    remainingMs: number,
    signal?: AbortSignal
  ): Promise<ResolvedAddress> {
    if (target.isIpLiteral) {
      assertAllowedAddress(target.hostname);
      return { address: target.hostname, family: target.hostname.includes(':') ? 6 : 4 };
    }
    if (signal?.aborted) timedOut();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new InterleafError(
            'validation',
            'That page took too long to respond, so Interleaf stopped waiting.'
          )
        );
      }, Math.max(remainingMs, 1));
      timer.unref();
      if (signal) {
        onAbort = (): void => {
          reject(
            new InterleafError(
              'validation',
              'That page took too long to respond, so Interleaf stopped waiting.'
            )
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      const resolved = await Promise.race([
        this.resolveAddresses(target.hostname, remainingMs),
        timeoutPromise,
      ]);
      if (resolved.length === 0) {
        failNetwork('Interleaf could not find that website.');
      }
      for (const entry of resolved) {
        assertAllowedAddress(entry.address);
      }
      const first = resolved[0];
      if (first === undefined) {
        failNetwork('Interleaf could not find that website.');
      }
      return first;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  private buildRequestOptions(
    target: ValidatedRequestUrl,
    pinned: ResolvedAddress,
    remainingMs: number
  ): RequestOptions {
    return {
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      agent: target.url.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      // No cookie, authorization, or referrer is ever attached: every fetch is
      // anonymous, so a hostile page cannot make Interleaf replay credentials.
      headers: {
        accept: this.options.accept,
        'accept-encoding': this.options.acceptEncoding,
        'accept-language': 'en',
        'user-agent': this.options.userAgent,
      },
      timeout: Math.min(SOCKET_IDLE_TIMEOUT_MS, Math.max(remainingMs, 1)),
      setHost: true,
      // Pin the already-validated address. The socket layer never resolves the
      // name again, so there is no second lookup for a rebinding resolver to win.
      lookup: (_hostname, lookupOptions, callback) => {
        // `all` decides the shape Node expects back; both branches answer with
        // the one address that was already checked against the address policy.
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
    };
  }

  private sendRequest(
    url: URL,
    requestOptions: RequestOptions,
    deadline: number,
    signal: AbortSignal | undefined,
    transfer: TransferBudget
  ): Promise<PinnedHopResult> {
    return new Promise<PinnedHopResult>((resolve, reject) => {
      const request = this.createRequest(url, requestOptions);
      const settle = createSettler(request, resolve, reject);
      const timer = setTimeout(() => {
        settle.rejectOnce(
          new InterleafError(
            'validation',
            'That page took too long to respond, so Interleaf stopped waiting.'
          )
        );
      }, Math.max(deadline - Date.now(), 1));
      // A pending import must never be the reason the process stays alive.
      timer.unref();
      settle.onDone(() => {
        clearTimeout(timer);
      });

      if (signal) {
        if (signal.aborted) {
          settle.rejectOnce(
            new InterleafError(
              'validation',
              'That page took too long to respond, so Interleaf stopped waiting.'
            )
          );
          return;
        }
        const onAbort = (): void => {
          settle.rejectOnce(
            new InterleafError(
              'validation',
              'That page took too long to respond, so Interleaf stopped waiting.'
            )
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        settle.onDone(() => {
          signal.removeEventListener('abort', onAbort);
        });
      }
      request.on('error', () => {
        settle.rejectOnce(new InterleafError('validation', 'Interleaf could not reach that website.'));
      });
      request.on('timeout', () => {
        settle.rejectOnce(
          new InterleafError(
            'validation',
            'That page took too long to respond, so Interleaf stopped waiting.'
          )
        );
      });
      request.on('response', (response: IncomingMessage) => {
        this.handleResponse(response, settle, transfer);
      });
      request.end();
    });
  }

  private handleResponse(
    response: IncomingMessage,
    settle: Settler,
    transfer: TransferBudget
  ): void {
    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS_CODES[status] === true) {
      const location = headerValue(response, 'location').trim();
      response.destroy();
      if (location === '') {
        settle.rejectOnce(new InterleafError('validation', 'That website sent an invalid redirect.'));
        return;
      }
      settle.resolveOnce({ kind: 'redirect', location });
      return;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      settle.rejectOnce(
        new InterleafError('validation', 'That website did not return a readable page.')
      );
      return;
    }

    try {
      this.options.validateResponse(response);
      this.assertDeclaredLength(response, transfer);
    } catch (error) {
      response.destroy();
      settle.rejectOnce(toError(error instanceof Error ? error : null));
      return;
    }

    this.collectBody(response, settle, transfer);
  }

  private assertDeclaredLength(response: IncomingMessage, transfer: TransferBudget): void {
    const declared = Number.parseInt(headerValue(response, 'content-length'), 10);
    if (Number.isFinite(declared) && declared > transfer.remaining) {
      failNetwork('That page is too large for Interleaf to import.');
    }
  }

  private collectBody(response: IncomingMessage, settle: Settler, transfer: TransferBudget): void {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      if (!transfer.charge(chunk.byteLength)) {
        // Stop reading immediately rather than after the body completes, so an
        // endless response cannot hold memory or the import slot. The bytes that
        // did arrive stay charged, so abandoning a response is not free.
        response.destroy();
        settle.rejectOnce(
          new InterleafError('validation', 'That page is too large for Interleaf to import.')
        );
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', () => {
      settle.rejectOnce(
        new InterleafError('validation', 'Interleaf lost the connection to that website.')
      );
    });
    response.on('end', () => {
      settle.resolveOnce({ kind: 'body', body: Buffer.concat(chunks), response });
    });
  }
}
