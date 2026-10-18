/**
 * Manual smoke check for the `local` provider against a real Ollama server.
 *
 * This is **not** part of the automated suite: it performs one real inference
 * on whatever loopback server is running, so it is opt-in and run by hand.
 *
 *   npx vitest run tests/manual/local-provider-smoke.manual.ts \
 *     --include 'tests/manual/**\/*.manual.ts'
 *
 * It exercises the production adapter — the same `LocalProvider` Reader Chat
 * uses — with a harmless prompt, no documents, no credentials and no external
 * content, and records only model, status, latency and whether the expected
 * marker appeared. Nothing about the response is persisted.
 */
import { describe, expect, it } from 'vitest';
import { LocalProvider } from '@main/ai/providers/local-provider';
import { DEFAULT_LOCAL_ENDPOINT } from '@shared/schemas/local-endpoint';

const MODEL = process.env.INTERLEAF_SMOKE_MODEL ?? 'qwen3:8b';
const MARKER = 'INTERLEAF_LOCAL_OK';

describe('manual: local provider against a running Ollama', () => {
  it('completes one small turn through the production adapter', async () => {
    const provider = new LocalProvider(() => ({
      mode: 'ollama',
      endpoint: DEFAULT_LOCAL_ENDPOINT,
      model: MODEL,
    }));

    const started = Date.now();
    let text = '';
    for await (const event of provider.streamChat({
      requestId: 'manual-local-smoke',
      modelId: MODEL,
      systemPrompt: 'Answer with the exact text requested and nothing else.',
      contextXml: '',
      history: [],
      userMessage: `Reply with exactly: ${MARKER}`,
      sources: [],
      webSearch: false,
    })) {
      if (event.type === 'token') text += event.token;
    }
    const latencyMs = Date.now() - started;

    // Only the shape of the outcome is reported; the reply itself is not kept.
    console.log(JSON.stringify({
      model: MODEL,
      status: 'completed',
      latencyMs,
      markerPresent: text.includes(MARKER),
    }));
    expect(text).toContain(MARKER);
  }, 120_000);
});
