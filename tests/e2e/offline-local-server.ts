import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The local-server endpoint an app under test is allowed to talk to.
 *
 * The `local` provider speaks HTTP to a loopback address, and a fresh profile
 * starts from the documented default `127.0.0.1:11434` — Ollama's port. On a
 * machine running Ollama the app therefore discovers a ready provider no spec
 * asked for and can send a turn to a model whose answers no assertion controls.
 * `PATH` sanitization cannot reach that: this provider is a socket, not a
 * binary.
 *
 * The suite closes it by owning the other end. Every launch is moved onto a
 * server started inside the test process, on a port the operating system just
 * handed this process, which answers every request with a refusal and keeps a
 * record of what was asked. That record is the evidence: an inference request
 * that reached this server demonstrably did not reach anybody's real one, and
 * a request that never appears here never happened at all.
 *
 * This deliberately replaces the previous `http://127.0.0.1:1` address. An
 * unbound-looking port number is an assumption about the host, not a property
 * of the run: nothing stops a machine from listening there, and a port number
 * alone can never evidence what the application did or did not send.
 *
 * What it does not close, and what no fixture here can close without changing
 * what the application sees: the endpoint lives in the profile's settings row,
 * and a settings row present before launch is exactly how the app tells a first
 * run from an upgrade (`onboarding-launch-state.ts`). Seeding one would take the
 * first-run flow away from every spec, so the endpoint is written through the
 * settings IPC as soon as the bridge exists instead, and the renderer is then
 * reloaded so its own copy of the settings document comes from this endpoint
 * too — see `pointLocalProviderAtTheTrap`. Without that reload the first panel
 * a spec collapses would submit the copy it hydrated and put the host's port
 * back.
 *
 * A launch can therefore still make its startup catalog read — one
 * `GET /v1/models`, never inference — against whatever holds the default port.
 * No turn can: sending happens in a spec body, long after the endpoint has
 * moved here and been read back.
 */
export type DenyAllLocalServer = {
  /** `http://127.0.0.1:<port>`, a real address this process is listening on. */
  readonly endpoint: string;
  /** Every request the app made to it, in arrival order. */
  readonly requests: readonly LocalServerRequest[];
};

type LocalServerRequest = {
  readonly method: string;
  readonly url: string;
};

let started: Promise<DenyAllLocalServer> | null = null;
let standIn: Promise<DenyAllLocalServer> | null = null;
const received: LocalServerRequest[] = [];
const standInReceived: LocalServerRequest[] = [];

function refuseInto(log: LocalServerRequest[], request: IncomingMessage, response: ServerResponse): void {
  log.push({ method: request.method ?? 'GET', url: request.url ?? '/' });
  // Drain the body so the client sees a complete exchange rather than a reset
  // mid-upload, which some HTTP clients report as a transport error instead of
  // the "server refused" the provider is meant to take its unavailable path on.
  request.resume();
  response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ error: 'This Interleaf E2E run has no local inference server.' }));
}

/**
 * The deny-all server for this worker, started on first use.
 *
 * One per worker process rather than one per launch: a preserved profile is
 * relaunched with the endpoint it already stores, so the address has to outlive
 * a single `AppHandle`. It is unreferenced, so it never holds the worker open
 * after the last spec finishes.
 */
export function denyAllLocalServer(): Promise<DenyAllLocalServer> {
  started ??= listenDenyAll(received);
  return started;
}

/**
 * A second owned server, standing in for the host's default inference port.
 *
 * The offline spec has to reproduce a profile pointed somewhere other than this
 * run's server — the state a renderer holds when it hydrated before the
 * endpoint moved. The address it uses for that is this one and never
 * `127.0.0.1:11434`: a regression test that reproduces "pointed at the host"
 * by actually pointing at the host would be the very thing this fixture exists
 * to prevent. Nothing reaches an inference server here either; it refuses
 * everything and records what it was asked, so a spec can assert that the app
 * sent it nothing at all.
 */
export function standInForHostDefault(): Promise<DenyAllLocalServer> {
  standIn ??= listenDenyAll(standInReceived);
  return standIn;
}

function listenDenyAll(log: LocalServerRequest[]): Promise<DenyAllLocalServer> {
  return new Promise<DenyAllLocalServer>((resolve, reject) => {
    const created = createServer((request, response) => { refuseInto(log, request, response); });
    created.on('error', reject);
    created.listen(0, '127.0.0.1', () => {
      const address = created.address() as AddressInfo;
      created.unref();
      resolve({ endpoint: `http://127.0.0.1:${String(address.port)}`, requests: log });
    });
  });
}

/** Requests recorded since `from`, for a spec asserting about one window. */
export function localServerRequestsSince(from: number): readonly LocalServerRequest[] {
  return received.slice(from);
}

