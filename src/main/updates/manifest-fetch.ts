import { MAX_MANIFEST_BYTES, UpdateVerificationError } from './update-manifest';
import { UpdateNetworkError, type ManifestFetcher } from './signed-release-provider';

/**
 * Bounded retrieval of one signed release manifest.
 *
 * Production passes Electron's `net.fetch`, which follows the system proxy
 * configuration like the rest of the app's networking. The request carries no
 * credential or token, gives up after a fixed time and stops reading as soon
 * as the body exceeds the manifest limit, so a hostile or broken response
 * cannot exhaust memory. What comes back is still untrusted until
 * `verifyUpdateManifest` accepts its signature.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MANIFEST_FETCH_TIMEOUT_MS = 20_000;

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpdateVerificationError('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createManifestFetcher(fetchImpl: FetchLike, timeoutMs = MANIFEST_FETCH_TIMEOUT_MS): ManifestFetcher {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url.href, {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store',
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        throw new UpdateNetworkError();
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: 'not-found' };
      }
      if (!response.ok || new URL(response.url || url.href).protocol !== url.protocol) {
        await response.body?.cancel();
        throw new UpdateNetworkError(`The release destination answered ${String(response.status)}.`);
      }
      return { status: 'found', text: await readBounded(response, MAX_MANIFEST_BYTES) };
    } finally {
      clearTimeout(timer);
    }
  };
}
