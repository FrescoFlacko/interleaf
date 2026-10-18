import type { ElectronApplication } from '@playwright/test';

/**
 * A fixed two-entry OpenRouter catalog: the shape `/api/v1/models` returns.
 * Served by the network guard below and asserted by the catalog spec.
 */
export const OPENROUTER_FIXTURE_CATALOG = {
  data: [
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Anthropic: Claude 3.5 Sonnet',
      context_length: 200_000,
      top_provider: { max_completion_tokens: 8_192 },
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      context_length: 128_000,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
    },
  ],
};

type GuardStore = {
  __interleafE2eNetworkGuard?: { readonly refused: string[] };
};

/**
 * Replaces main's `fetch` for the whole life of an app under test, before any
 * spec can reach a network path.
 *
 * - Literal loopback stays reachable: the deny-all local server this suite owns
 *   is the only thing listening for it. Redirects from it are never followed.
 * - OpenRouter's unauthenticated catalog and its key check are answered from
 *   fixtures, so a Settings panel or connection test never leaves the machine.
 * - Every other request — including chat completions a spec has not stubbed —
 *   is refused with a network error and its origin and path are recorded
 *   (never its query or headers).
 *
 * Specs that stub a response wrap this function rather than the real one, so
 * their pass-through for anything they do not handle fails closed here.
 * Main's other outbound transports (`node:http` for the loopback provider and,
 * outside the test seam, web-article import) are not routed through `fetch`
 * and are covered by their own deny-all server and test transports.
 */
export async function installMainNetworkGuard(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate((_, catalog) => {
    const store = globalThis as GuardStore;
    if (store.__interleafE2eNetworkGuard !== undefined) return;
    const refused: string[] = [];
    store.__interleafE2eNetworkGuard = { refused };
    const loopbackFetch = globalThis.fetch;
    const json = (body: object): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
        // A loopback answer could redirect anywhere; refuse to follow it.
        // Set after the spread so a caller's own redirect mode cannot win.
        return loopbackFetch(input, { ...init, redirect: 'error' });
      }
      if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/models') return json(catalog);
      if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/auth/key') {
        return json({ data: { label: 'e2e-fixture', usage: 0, limit: null, is_free_tier: false } });
      }
      refused.push(`${url.origin}${url.pathname}`);
      throw new TypeError('E2E network guard refused a non-loopback request.');
    };
  }, OPENROUTER_FIXTURE_CATALOG);
}

/** Origins and paths main tried to reach that the guard refused. */
export async function refusedMainRequests(electronApp: ElectronApplication): Promise<readonly string[]> {
  return electronApp.evaluate(() => [...((globalThis as GuardStore).__interleafE2eNetworkGuard?.refused ?? [])]);
}
