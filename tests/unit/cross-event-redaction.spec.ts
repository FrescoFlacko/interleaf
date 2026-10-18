import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { AgentEventView } from '@main/agents/redactable-event';
import type { AgentEvent, AgentEventDraft } from '@shared/types/agent';
import { agentEventSchema } from '@shared/schemas/agent';
import { silentLogger as silentLog } from '../helpers/silent-logger';
import { type MutablePortableRecord, type MutablePortableValue, type PortableRecord, type PortableValue, isPortableArray, isPortableRecord } from '@shared/models/portable';
import {
  EventRedactor,
  redactNonStreamEvents,
  redactRecord,
  redactText,
  findRedactionRangesInText,
  SECRET_ASSIGNMENT_NAMES,
} from '@main/agents/event-redaction';
import { createTestAgentService } from '../helpers/agent-service';
import { withEnvironmentShell, testAgentRegistryOptions } from '../helpers/agent-collaborators';
/** Reads any event variant through the redactor's flat payload view. */
function view(event: AgentEventDraft | undefined): AgentEventView | undefined {
  return event;
}

const roots: string[] = [];
const applyDatabaseMigrations = runMigrations;

function runTestMigrations(db: ReturnType<typeof InterleafDatabase.open>): void {
  applyDatabaseMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents
      (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('test-doc-id', 'Test document', 'pdf', '/tmp/test-doc.pdf', 'managed', 1, 1, 'test-doc-hash')
  `).run();
}

async function makeTempDir(prefix = 'ml-cross-redact-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * A gate a scripted generator awaits. The run consumer pulls the next event
 * only after it has persisted and emitted the previous one, so once the
 * generator reaches `wait()` — and `reached` resolves — every event yielded
 * before it has been fully delivered, and anything still held is held by the
 * redactor rather than by scheduling.
 */
function scriptGate() {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, wait: () => { arrive(); return opened; } };
}

/**
 * Waits for the session's terminal row. The consumer writes it only after the
 * event stream is drained and every event is persisted and emitted.
 */
async function untilSettled(repository: AgentRepository, sessionId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(repository.getSession(sessionId)).toMatchObject({ status: expect.stringMatching(/^(?:completed|failed|cancelled|interrupted)$/u) });
  });
}

export type ExtractedPayloadStreams = {
  readonly values: string[];
  readonly keys: string[];
  readonly unified: string[];
  readonly allRecursiveKeys: string[];
};

/**
 * Extracts text-bearing payload locations in strict event order:
 * - values: all string values (and event.text)
 * - keys: all object keys across data and error
 * - unified: natural recursive traversal (event.text, then key before its value recursively)
 * - allRecursiveKeys: all raw object keys visited
 *
 * Explicitly EXCLUDES envelope metadata: sessionId, type, timestamp, stream, exitCode, signal, code, __interleafError.
 */
export function extractPayloadStreams(
  events: readonly (AgentEvent | AgentEventDraft)[],
): ExtractedPayloadStreams {
  const values: string[] = [];
  const keys: string[] = [];
  const unified: string[] = [];
  const allRecursiveKeys: string[] = [];
  const seen = new WeakSet<object>();

  function collectFromObject(record: PortableRecord, depth: number): void {
    if (depth > 10 || seen.has(record)) return;
    seen.add(record);
    for (const key of Object.keys(record)) {
      if (key === '__interleafError' || key === 'code') continue;
      keys.push(key);
      unified.push(key);
      allRecursiveKeys.push(key);

      const val = record[key];
      if (typeof val === 'string') {
        values.push(val);
        unified.push(val);
      } else if (isPortableArray(val)) {
        collectFromArray(val, depth + 1);
      } else if (isPortableRecord(val)) {
        collectFromObject(val, depth + 1);
      }
    }
  }
  function collectFromArray(arr: readonly PortableValue[], depth: number): void {
    if (depth > 10 || seen.has(arr)) return;
    seen.add(arr);
    for (const item of arr) {
      if (typeof item === 'string') {
        values.push(item);
        unified.push(item);
      } else if (isPortableArray(item)) {
        collectFromArray(item, depth + 1);
      } else if (isPortableRecord(item)) {
        collectFromObject(item, depth + 1);
      }
    }
  }
  for (const event of events.map(view)) {
    if (event === undefined) continue;
    if (typeof event.text === 'string') {
      values.push(event.text);
      unified.push(event.text);
    }
    if (event.data !== undefined) {
      collectFromObject(event.data, 0);
    }
    if (event.error !== undefined) {
      collectFromObject(event.error, 0);
    }
  }

  return { values, keys, unified, allRecursiveKeys };
}

export function extractPayloadStringLeaves(
  events: readonly (AgentEvent | AgentEventDraft)[],
): string[] {
  return extractPayloadStreams(events).unified;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
const fakeProfile: MainAgentProfile = {
  id: 'fake',
  name: 'Adversarial Fake Adapter',
  providerId: 'fake',
  binaryPath: '/fake/bin/node',
  defaultArgs: [],
  defaultModel: 'fake-model',
  reasoningEffort: null,
  permissionMode: 'normal',
  defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true,
    sessionResume: false,
    nativeSandbox: false,
    workingDirectory: true,
    modelSelection: false,
    reasoningSelection: false,
    fileChangeEvents: true,
    toolEvents: true,
    subagents: false,
    interactiveAuthentication: false,
    nonInteractiveMode: true,
  },
  detection: {
    availability: 'installed',
    binaryPath: '/fake/bin/node',
    version: '1.0.0-test',
    checkedAt: new Date().toISOString(),
    errorMessage: null,
  },
  isCustom: false,
  unsafe: false,
};

class ScriptedAdapter implements AgentAdapter {
  readonly profile: MainAgentProfile;
  readonly capabilities: MainAgentProfile['capabilities'];
  constructor(
    private readonly eventGenerator: () => AsyncGenerator<AgentEvent, void, void>,
    profile: MainAgentProfile = fakeProfile,
  ) {
    this.profile = profile;
    this.capabilities = profile.capabilities;
  }

  detect() { return Promise.resolve(this.profile.detection); }
  start(): AgentAdapterRun {
    return {
      events: this.eventGenerator(),
      cancel: () => undefined,
      completion: Promise.resolve(),
    };
  }
  cancel() { /* noop */ }
}

/** The fake profile with one host variable inherited, so its value is a registered secret. */
function inheritingProfile(name: string): MainAgentProfile {
  return { ...fakeProfile, environmentOverrides: [{ name, action: 'inherit-allowlisted' }] };
}

async function makeWorkDir(): Promise<string> {
  const workDir = join(await makeTempDir('ml-adv-'), 'workdir');
  await mkdir(workDir, { recursive: true });
  return workDir;
}

/**
 * Starts an isolated-copy session whose only adapter is `adapter`, subscribed
 * from before the first event so `receivedEvents` sees the full stream.
 */
async function startScriptedSession(adapter: ScriptedAdapter, workDir: string) {
  const { profile } = adapter;
  class ScriptedRegistry extends AgentRegistry {
    override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([profile]); }
    override addFakeAdapter(): MainAgentProfile { return profile; }
    override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
  }
  const root = dirname(workDir);
  const db = InterleafDatabase.open(':memory:');
  runTestMigrations(db);
  const repository = new AgentRepository(db);
  const dirRegistry = new WorkingDirectoryRegistry();
  const service = createTestAgentService({
    database: db,
    repository,
    registry: dirRegistry,
    agentRegistry: new ScriptedRegistry(testAgentRegistryOptions()),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(workDir),
    isPackaged: false,
    log: silentLog,
    isGitRepository: () => Promise.resolve(false),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'env') })),
  });
  await service.initialize();
  const receivedEvents: AgentEvent[] = [];
  service.subscribe(1, (event) => { receivedEvents.push(event); });
  const selection = await dirRegistry.register(workDir);
  const { session } = await service.startSession({ documentId: 'test-doc-id', profileId: 'fake',
    workingDirectoryHandle: selection.handle, prompt: 'test prompt', executionMode: 'isolated-copy' }, 1);
  // Drain the service before the database goes away: a consumer still
  // writing into a closed database rejects with nothing left to catch it.
  const close = async () => { await service.shutdown(); db.close(); };
  return { repository, receivedEvents, sessionId: session.id, close };
}

describe('Cross-Event Non-Stream Redaction & Adversarial Adapter Tests', () => {
  describe('event-redaction unit logic', () => {
    it('redacts registered generic and path secrets by canonical primitive JSON spelling', () => {
      const secrets = [
        { value: '1', kind: 'generic' as const },
        { value: '1.0', kind: 'generic' as const },
        { value: '1e3', kind: 'generic' as const },
        { value: '1E+3', kind: 'generic' as const },
        { value: '-1.0', kind: 'generic' as const },
        { value: '-0', kind: 'generic' as const },
        { value: 'true', kind: 'generic' as const },
        { value: 'false', kind: 'generic' as const },
        { value: 'null', kind: 'generic' as const },
        { value: '42', kind: 'path' as const },
      ];
      expect(redactRecord({ number: 1, yes: true, no: false, none: null, safeNumber: 2, pathSecret: 42 }, secrets)).toEqual({
        number: '[REDACTED]',
        yes: '[REDACTED]',
        no: '[REDACTED]',
        none: '[REDACTED]',
        safeNumber: 2,
        pathSecret: '[REDACTED]',
      });
      expect(redactRecord({ negative: -2, decimal: 1.25, exponent: 1e3, normalizedNegative: -1, expUpper: 1000 }, secrets)).toEqual({
        negative: -2,
        decimal: 1.25,
        exponent: '[REDACTED]',
        normalizedNegative: '[REDACTED]',
        expUpper: '[REDACTED]',
      });
      expect(redactRecord({ leading: 1 }, [{ value: '01', kind: 'generic' }])).toEqual({ leading: 1 });
      expect(redactRecord({ negativeZero: -0, positiveZero: 0, nonFiniteNaN: Number.NaN, nonFiniteInf: Number.POSITIVE_INFINITY, nonFiniteNegInf: Number.NEGATIVE_INFINITY }, [{ value: '-0', kind: 'generic' }])).toEqual({
        negativeZero: '[REDACTED]',
        positiveZero: '[REDACTED]',
        nonFiniteNaN: '[REDACTED]',
        nonFiniteInf: '[REDACTED]',
        nonFiniteNegInf: '[REDACTED]',
      });
      expect(redactRecord({ nested: { a: [1, 2], b: { c: true, d: false, e: null } } }, [{ value: '1', kind: 'path' }, { value: 'true', kind: 'generic' }])).toEqual({
        nested: { a: ['[REDACTED]', 2], b: { c: '[REDACTED]', d: false, e: null } },
      });
    });

    it('redacts parsed primitive leaves across data and error in EventRedactor stream and finish', () => {
      const secrets = [
        { value: '1', kind: 'generic' as const },
        { value: '1.0', kind: 'generic' as const },
        { value: '1e3', kind: 'generic' as const },
        { value: '-0', kind: 'generic' as const },
        { value: 'true', kind: 'generic' as const },
        { value: 'false', kind: 'generic' as const },
        { value: 'null', kind: 'generic' as const },
        { value: '42', kind: 'path' as const },
      ];
      const redactor = new EventRedactor(secrets);

      const pushed = redactor.push({
        sessionId: 's-primitive-redactor',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          numberOne: 1,
          exponent: 1000,
          negativeZero: -0,
          yesVal: true,
          noVal: false,
          emptyVal: null,
          pathNum: 42,
          safeNum: 2,
          safeExp: 1001,
          nested: {
            arr: [1, 2, { deep: true, deepNo: false }],
          },
        },
      });
      expect(pushed).toHaveLength(0);
      const pushedError = redactor.push({
        sessionId: 's-primitive-redactor',
        type: 'error',
        timestamp: '2026-08-25T00:00:01.000Z',
        error: {
          __interleafError: true,
          code: 'internal',
          message: 'error message',
          attempt: 1,
          safeAttempt: 5,
        },
      });

      const finished = [...pushedError, ...redactor.finish()];
      expect(finished).toHaveLength(2);
      const drained = view(finished[0]);
      expect(drained?.type).toBe('structured');
      expect(drained?.data).toEqual({
        numberOne: '[REDACTED]',
        exponent: '[REDACTED]',
        negativeZero: '[REDACTED]',
        yesVal: '[REDACTED]',
        noVal: '[REDACTED]',
        emptyVal: '[REDACTED]',
        pathNum: '[REDACTED]',
        safeNum: 2,
        safeExp: 1001,
        nested: {
          arr: ['[REDACTED]', 2, { deep: '[REDACTED]', deepNo: '[REDACTED]' }],
        },
      });
      expect(view(finished[1])?.error).toEqual({
        __interleafError: '[REDACTED]',
        code: 'internal',
        message: 'error message',
        attempt: '[REDACTED]',
        safeAttempt: 5,
      });
    });

    it('redacts sensitive assignment values when key is double-quoted, single-quoted, or unquoted', () => {
      const secret = 'super-secret-key-val-123';
      // Double-quoted key in JSON format
      expect(redactText(`{"api_key":"${secret}"}`)).toBe('{"api_key":"[REDACTED]"}');
      expect(redactText(`{"api_key": "${secret}"}`)).toBe('{"api_key": "[REDACTED]"}');
      expect(redactText(`{"token": "${secret}", "password": "${secret}"}`)).toBe('{"token": "[REDACTED]", "password": "[REDACTED]"}');

      // Single-quoted key
      expect(redactText(`{'api_key':'${secret}'}`)).toBe("{'api_key':'[REDACTED]'}");
      expect(redactText(`{'access_token': '${secret}'}`)).toBe("{'access_token': '[REDACTED]'}");

      // Escaped quotes inside double-quoted value
      expect(redactText(`{"api_key": "my \\"escaped\\" secret"}`)).toBe('{"api_key": "[REDACTED]"}');

      // Unquoted values
      expect(redactText(`{"client_secret": 98765, "safe": true}`)).toBe('{"client_secret": [REDACTED], "safe": true}');

      // Mismatched quotes should NOT match as quoted assignment
      expect(redactText(`"api_key': "${secret}"`)).not.toContain('[REDACTED]');
      expect(redactText(`'api_key": "${secret}"`)).not.toContain('[REDACTED]');

      // Substrings of key names should NOT match
      expect(redactText(`"my_api_key_custom": "${secret}"`)).not.toContain('[REDACTED]');
      expect(redactText(`prefix_api_key="${secret}"`)).not.toContain('[REDACTED]');
    });

    it('redacts word-like secrets split across 1, 2, and 3 events embedded inside larger tokens without quarantining safe terminal text', () => {
      const redactor = new EventRedactor([
        { value: 'true', kind: 'generic' },
        { value: 'false', kind: 'generic' },
        { value: 'null', kind: 'generic' },
      ]);

      // 3-event split of "true" embedded as "prefix_t" + "r" + "ue_suffix"
      const r1 = redactor.push({
        sessionId: 's-split-3',
        type: 'stdout',
        stream: 'stdout',
        text: 'token_prefix_t',
        timestamp: '2026-08-25T00:00:00.000Z',
      });
      expect(r1).toHaveLength(0);

      const r2 = redactor.push({
        sessionId: 's-split-3',
        type: 'stdout',
        stream: 'stdout',
        text: 'r',
        timestamp: '2026-08-25T00:00:01.000Z',
      });
      expect(r2).toHaveLength(0);

      const r3 = redactor.push({
        sessionId: 's-split-3',
        type: 'stdout',
        stream: 'stdout',
        text: 'ue_suffix\n',
        timestamp: '2026-08-25T00:00:02.000Z',
      });
      expect(r3.length).toBeGreaterThanOrEqual(1);

      // Final terminal text that ends in "t" (e.g. "final direct report") must NOT trigger false quarantine
      const r4 = redactor.push({
        sessionId: 's-split-3',
        type: 'final',
        text: 'final direct report',
        timestamp: '2026-08-25T00:00:03.000Z',
      });

      const finished = redactor.finish();
      const allEvents = [...r1, ...r2, ...r3, ...r4, ...finished];
      const joinedText = allEvents.map((e) => view(e)?.text ?? '').join('');
      expect(joinedText).not.toContain('prefix_true_suffix');
      expect(joinedText).toContain('token_prefix_[REDACTED]');
      expect(joinedText).toContain('_suffix');
      expect(allEvents.find((e) => e.type === 'final')?.text).toBe('final direct report');
      expect(redactor.isQuarantined).toBe(false);
    });

    it('redacts bracketed assignment values without treating square brackets as generic delimiters', () => {
      const unknownSecret = 'unregistered-secret-7d2c';
      const registeredSecret = 'known-registered-secret-91af';

      const unknownText = `api_key=[${unknownSecret}]`;
      const unknownRanges = findRedactionRangesInText(unknownText);
      expect(unknownRanges).toContainEqual([8, unknownText.length]);
      expect(redactText(unknownText)).toBe('api_key=[REDACTED]');
      expect(redactText(unknownText)).not.toContain(unknownSecret);

      const registeredText = `token=[${registeredSecret}]`;
      const registeredRanges = findRedactionRangesInText(registeredText, [
        { value: registeredSecret, kind: 'generic' },
      ]);
      expect(registeredRanges).toContainEqual([6, registeredText.length]);
      expect(redactText(registeredText, [{ value: registeredSecret, kind: 'generic' }])).toBe('token=[REDACTED]');
    });

    it('holds bracketed assignment fragments across value refs and events before redaction', () => {
      const unknownSecret = 'unknown-bracket-secret-42be';
      const registeredSecret = 'known-bracket-secret-a811';
      const redactor = new EventRedactor([{ value: registeredSecret, kind: 'generic' }]);
      const first = redactor.push({
        sessionId: 's-bracket-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          unknownPrefix: `api_key=[${unknownSecret.slice(0, 9)}`,
          registeredPrefix: `token=[${registeredSecret.slice(0, 8)}`,
        },
      });
      expect(first).toHaveLength(0);

      const second = redactor.push({
        sessionId: 's-bracket-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: {
          unknownSuffix: `${unknownSecret.slice(9)}]`,
          registeredSuffix: `${registeredSecret.slice(8)}]`,
        },
      });
      const redacted = [...second, ...redactor.finish()];
      const payload = extractPayloadStreams(redacted);
      expect(payload.values.join('')).not.toContain(unknownSecret);
      expect(payload.values.join('')).not.toContain(registeredSecret);
      expect(payload.unified.join('')).not.toContain(unknownSecret);
      expect(payload.unified.join('')).not.toContain(registeredSecret);
      expect(JSON.stringify(redacted)).not.toContain(unknownSecret);
      expect(JSON.stringify(redacted)).not.toContain(registeredSecret);
    });

    it('keeps an existing redaction token stable beside safe assignment content', () => {
      const text = 'api_key=[REDACTED] safe_property=visible';
      expect(redactText(text)).toBe(text);
      expect(redactText('api_key=[REDACTED]safe_property=visible')).toBe('api_key=[REDACTED]safe_property=visible');
    });

    it.each([
      ['path at offset 1', '/Users/alice/private-workspace', 1],
      ['path at offset 2', '/Users/alice/private-workspace', 2],
      ['path at the final cut', '/Users/alice/private-workspace', '/Users/alice/private-workspace'.length - 1],
      ['registered environment at offset 1', 'INHERITED_ENV_SECRET_42f8', 1],
      ['registered environment at the final cut', 'INHERITED_ENV_SECRET_42f8', 'INHERITED_ENV_SECRET_42f8'.length - 1],
    ])('fails closed for an unresolved %s at EventRedactor finish', (_label, secret, cut) => {
      const redactor = new EventRedactor([{
        value: secret,
        kind: secret.startsWith('/') ? 'path' : 'generic',
      }]);
      const prefix = secret.slice(0, cut);
      expect(redactor.push({
        sessionId: 's-eof-prefix',
        type: 'final',
        timestamp: '2026-08-25T00:00:00.000Z',
        text: prefix,
      })).toHaveLength(0);

      const terminal = redactor.finish();
      expect(terminal).toHaveLength(1);
      expect(view(terminal[0])?.text).toBe('[REDACTED]');
      expect(extractPayloadStreams(terminal).values.join('')).not.toContain(prefix);
    });

    it('preserves safe bounded EOF text when it is not a registered prefix', () => {
      const redactor = new EventRedactor([{ value: '/Users/alice/private-workspace', kind: 'path' }]);
      redactor.push({
        sessionId: 's-safe-eof',
        type: 'final',
        timestamp: '2026-08-25T00:00:00.000Z',
        text: 'safe EOF output',
      });
      const terminal = redactor.finish();
      expect(view(terminal[0])?.text).toBe('safe EOF output');
      expect(JSON.stringify(terminal)).not.toContain('/Users/alice/private-workspace');
    });

    it('holds a lone one-character payload, then drains it FIFO after safe lookahead', () => {
      const redactor = new EventRedactor();
      const first = redactor.push({
        sessionId: 's-one-character-safe',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { value: 't' },
      });
      expect(first).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);

      const second = redactor.push({
        sessionId: 's-one-character-safe',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { value: 'safe' },
      });
      expect(second).toHaveLength(1);
      expect(view(second[0])?.data?.value).toBe('t');
      expect(redactor.pendingCount).toBe(1);

      const final = redactor.finish();
      expect(final).toHaveLength(1);
      expect(view(final[0])?.data?.value).toBe('safe');
    });

    it('drains large safe payloads after one lookahead without accumulating or quarantining', () => {
      const redactor = new EventRedactor();
      const largeSafeText = 'Z'.repeat(600);
      const first = redactor.push({
        sessionId: 's-large-safe',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { safe: largeSafeText },
      });
      expect(first).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);

      const second = redactor.push({
        sessionId: 's-large-safe',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { safe: 'next-safe-payload' },
      });
      expect(second).toHaveLength(1);
      expect(view(second[0])?.data?.safe).toBe(largeSafeText);
      expect(redactor.pendingCount).toBe(1);
      expect(redactor.isQuarantined).toBe(false);

      for (let index = 0; index < 200; index += 1) {
        const drained = redactor.push({
          sessionId: 's-large-safe',
          type: 'structured',
          timestamp: new Date(2026, 7, 25, 0, 0, 2 + index).toISOString(),
          data: { safe: `${largeSafeText}_${String(index)}` },
        });
        expect(drained).toHaveLength(1);
        expect(redactor.pendingCount).toBe(1);
        expect(redactor.pendingChars).toBeLessThanOrEqual(2_000);
        expect(redactor.isQuarantined).toBe(false);
      }
    });

    it('collapses dense short-secret range matches before they can expand bounded refs', () => {
      const registeredSecret = 'q';
      const nearLimitText = 'qX'.repeat(32_500);
      const denseNestedValue = 'qX'.repeat(2_000);
      const overwideKey = 'q'.repeat(256);
      const denseErrorMessage = 'qX'.repeat(1_000);
      const manyShortRefs: MutablePortableRecord = {};
      for (let index = 0; index < 128; index += 1) {
        manyShortRefs[`entry_${String(index)}`] = Array.from({ length: 128 }, () => registeredSecret);
      }
      const events: AgentEventDraft[] = [
        {
          sessionId: 's-redaction-expansion',
          type: 'final',
          timestamp: '2026-08-25T00:00:00.000Z',
          text: nearLimitText,
        },
        {
          sessionId: 's-redaction-expansion',
          type: 'structured',
          timestamp: '2026-08-25T00:00:01.000Z',
          data: {
            [overwideKey]: { nestedDiagnostic: denseNestedValue },
          },
        },
        {
          sessionId: 's-redaction-expansion',
          type: 'structured',
          timestamp: '2026-08-25T00:00:02.000Z',
          data: manyShortRefs,
        },
        {
          sessionId: 's-redaction-expansion',
          type: 'error',
          timestamp: '2026-08-25T00:00:03.000Z',
          error: {
            __interleafError: true,
            code: 'internal',
            message: denseErrorMessage,
          },
        },
        {
          sessionId: 's-redaction-expansion',
          type: 'structured',
          timestamp: '2026-08-25T00:00:04.000Z',
          data: { safe: 'lookahead' },
        },
      ];

      const redacted = redactNonStreamEvents(events, [{ value: registeredSecret, kind: 'generic' }]);
      expect(redacted).toHaveLength(events.length);
      for (const [ordinal, event] of redacted.entries()) {
        const parsed = agentEventSchema.safeParse({ ...event, ordinal });
        expect(parsed.success).toBe(true);
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain(registeredSecret);
        expect(serialized.length).toBeLessThanOrEqual(100_000);
        const { data, error } = view(event) ?? {};
        if (data !== undefined) {
          expect(JSON.stringify(data).length).toBeLessThanOrEqual(65_536);
          expect(Object.keys(data).every((key) => key.length <= 256)).toBe(true);
        }
        if (error !== undefined) {
          expect(error.message.length).toBeLessThanOrEqual(2_000);
        }
      }

      const textEvent = view(redacted[0]);
      expect(textEvent?.text).toBe('[REDACTED]');
      const dataEvent = view(redacted[1]);
      expect(dataEvent?.data).toEqual({ '[REDACTED]': { nestedDiagnostic: '[REDACTED]' } });
      expect(view(redacted[2])?.data).toEqual({ redacted: true });
      const errorEvent = view(redacted[3]);
      expect(errorEvent?.error?.message).toBe('[REDACTED]');

      const nearLimitData = redactNonStreamEvents([
        {
          sessionId: 's-redaction-expansion-data',
          type: 'structured',
          timestamp: '2026-08-25T00:00:00.000Z',
          data: { nearLimit: 'qX'.repeat(32_000) },
        },
        {
          sessionId: 's-redaction-expansion-data',
          type: 'structured',
          timestamp: '2026-08-25T00:00:01.000Z',
          data: { safe: 'lookahead' },
        },
      ], [{ value: registeredSecret, kind: 'generic' }]);
      const nearLimitDataEvent = nearLimitData[0];
      expect(agentEventSchema.safeParse({ ...nearLimitDataEvent, ordinal: 0 }).success).toBe(true);
      expect(view(nearLimitDataEvent)?.data?.nearLimit).toBe('[REDACTED]');
      expect(JSON.stringify(nearLimitDataEvent)).not.toContain(registeredSecret);
    });

    it('holds a newline-split registered multiline secret before the safe newline fast path', () => {
      const secret = 'A\nMULTILINE_ENV_SECRET_42f8';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      const first = redactor.push({
        sessionId: 's-multiline-short-prefix',
        type: 'stdout',
        stream: 'stdout',
        timestamp: '2026-08-25T00:00:00.000Z',
        text: secret.slice(0, 2),
      });
      expect(first).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);

      const second = redactor.push({
        sessionId: 's-multiline-short-prefix',
        type: 'stdout',
        stream: 'stdout',
        timestamp: '2026-08-25T00:00:01.000Z',
        text: secret.slice(2),
      });
      expect(second).toHaveLength(0);
      expect(redactor.pendingCount).toBe(2);

      const terminal = redactor.push({
        sessionId: 's-multiline-short-prefix',
        type: 'ended',
        timestamp: '2026-08-25T00:00:02.000Z',
        exitCode: 0,
        signal: null,
      });
      const all = [...first, ...second, ...terminal];
      expect(all.map((event) => event.type)).toEqual(['stdout', 'stdout', 'ended']);
      expect(extractPayloadStreams(all).values.join('')).not.toContain(secret);
    });

    it.each([
      ['one-character', 'q'],
      ['two-character', 'xy'],
      ['three-character', 'RST'],
    ])('redacts explicitly registered %s generic secrets in full and split occurrences', (_label, secret) => {
      expect(redactText(`full-${secret}-occurrence`, [{ value: secret, kind: 'generic' }])).not.toContain(secret);
      expect(findRedactionRangesInText(`full-${secret}-occurrence`, [{ value: secret, kind: 'generic' }])).not.toHaveLength(0);

      const fullRedactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      const fullPush = fullRedactor.push({
        sessionId: `s-short-generic-${_label}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { full: `full-${secret}-occurrence` },
      });
      const fullLookahead = fullRedactor.push({
        sessionId: `s-short-generic-${_label}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { safe: 'lookahead' },
      });
      const fullLeaves = extractPayloadStreams([...fullPush, ...fullLookahead, ...fullRedactor.finish()]).values.join('');
      expect(fullLeaves).not.toContain(secret);

      if (secret.length > 1) {
        const splitRedactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
        const splitPrefix = splitRedactor.push({
          sessionId: `s-short-generic-split-${_label}`,
          type: 'structured',
          timestamp: '2026-08-25T00:00:00.000Z',
          data: { split: secret.slice(0, 1) },
        });
        const splitSuffix = splitRedactor.push({
          sessionId: `s-short-generic-split-${_label}`,
          type: 'structured',
          timestamp: '2026-08-25T00:00:01.000Z',
          data: { split: secret.slice(1) },
        });
        const splitTerminal = splitRedactor.push({
          sessionId: `s-short-generic-split-${_label}`,
          type: 'ended',
          timestamp: '2026-08-25T00:00:02.000Z',
          exitCode: 0,
          signal: null,
        });
        const splitLeaves = extractPayloadStreams([...splitPrefix, ...splitSuffix, ...splitTerminal]).values.join('');
        expect(splitLeaves).not.toContain(secret);
      }
    });

    it.each([
      ['sk token', 'sk-abcdefghijklmno'],
      ['JWT', 'eyJheaderpart.longpayloadpart.signaturepart'],
      ['private-key header', '-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----'],
      ['Bearer token', 'Bearer opaque-bearer-value-42f8'],
    ])('holds a one-character %s prefix before suffix lookahead', (_label, secret) => {
      const redactor = new EventRedactor();
      const first = redactor.push({
        sessionId: `s-built-in-split-${_label}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { fragment: secret.slice(0, 1) },
      });
      expect(first).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);

      const second = redactor.push({
        sessionId: `s-built-in-split-${_label}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { fragment: secret.slice(1) },
      });
      const terminal = redactor.push({
        sessionId: `s-built-in-split-${_label}`,
        type: 'ended',
        timestamp: '2026-08-25T00:00:02.000Z',
        exitCode: 0,
        signal: null,
      });
      const all = [...first, ...second, ...terminal];
      expect(all.map((event) => event.type)).toEqual(['structured', 'structured', 'ended']);
      const streams = extractPayloadStreams(all);
      for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) {
        expect(stream.join('')).not.toContain(secret);
      }
    });

    it('keeps the Codex repository-check flag visible while redacting supported token forms', () => {
      expect(redactText('--skip-git-repo-check')).toBe('--skip-git-repo-check');
      expect(redactText('sk-proj-abcdefghijklmno')).toBe('[REDACTED]');
      expect(redactText('sk_abcdefghijklmno')).toBe('[REDACTED]');
      expect(redactText('ghp_abcdefghijklmno')).toBe('[REDACTED]');
      expect(redactText('xoxb-abcdefghijklmno')).toBe('[REDACTED]');
    });

    it('holds an alias-name split before authorization credential redaction', () => {
      const credential = 'opaque-authorization-credential-42f8';
      const redactor = new EventRedactor();
      const first = redactor.push({
        sessionId: 's-alias-name-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { fragment: 'a' },
      });
      expect(first).toHaveLength(0);

      const second = redactor.push({
        sessionId: 's-alias-name-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { fragment: 'uthorization=' },
      });
      expect(second).toHaveLength(0);

      const third = redactor.push({
        sessionId: 's-alias-name-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:02.000Z',
        data: { fragment: credential },
      });
      const terminal = redactor.push({
        sessionId: 's-alias-name-split',
        type: 'ended',
        timestamp: '2026-08-25T00:00:03.000Z',
        exitCode: 0,
        signal: null,
      });
      const all = [...first, ...second, ...third, ...terminal];
      expect(all.map((event) => event.type)).toEqual(['structured', 'structured', 'structured', 'ended']);
      const streams = extractPayloadStreams(all);
      for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) {
        expect(stream.join('')).not.toContain(`authorization=${credential}`);
        expect(stream.join('')).not.toContain(credential);
      }
    });

    it.each([
      ['canonical path', '/Users/alice/private-workspace', 'path' as const],
      ['inherited environment secret', 'INHERITED_ENV_SECRET_42f8', 'generic' as const],
    ])('holds %s fragments split at offsets 1 and 2 until terminal release', (_label, secret, kind) => {
      for (const offset of [1, 2]) {
        const redactor = new EventRedactor([{ value: secret, kind }]);
        const first = redactor.push({
          sessionId: `s-short-split-${String(offset)}`,
          type: 'structured',
          timestamp: '2026-08-25T00:00:00.000Z',
          data: { fragment: secret.slice(0, offset) },
        });
        expect(first).toHaveLength(0);
        expect(redactor.pendingCount).toBe(1);

        const second = redactor.push({
          sessionId: `s-short-split-${String(offset)}`,
          type: 'structured',
          timestamp: '2026-08-25T00:00:01.000Z',
          data: { fragment: secret.slice(offset) },
        });
        expect(second).toHaveLength(0);
        expect(redactor.pendingCount).toBe(2);

        const terminal = redactor.push({
          sessionId: `s-short-split-${String(offset)}`,
          type: 'ended',
          timestamp: '2026-08-25T00:00:02.000Z',
          exitCode: 0,
          signal: null,
        });
        expect(terminal.map((event) => event.type)).toEqual(['structured', 'structured', 'ended']);
        const streams = extractPayloadStreams(terminal);
        for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) {
          expect(stream.join('')).not.toContain(secret);
          expect(stream.join('')).not.toContain(secret.slice(0, offset));
          expect(stream.join('')).not.toContain(secret.slice(offset));
        }
      }
    });

    it.each(SECRET_ASSIGNMENT_NAMES)('holds authoritative %s= assignments before the next event supplies the credential', (name) => {
      const redactor = new EventRedactor();
      const first = redactor.push({
        sessionId: `s-assignment-${name}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: { output: `${name}=` },
      });
      expect(first).toHaveLength(0);

      const second = redactor.push({
        sessionId: `s-assignment-${name}`,
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: { output: 'opaque-inherited-credential-42f8' },
      });
      expect(second).toHaveLength(0);

      const terminal = redactor.push({
        sessionId: `s-assignment-${name}`,
        type: 'ended',
        timestamp: '2026-08-25T00:00:02.000Z',
        exitCode: 0,
        signal: null,
      });
      expect(extractPayloadStreams(terminal).values.join('')).not.toContain('opaque-inherited-credential-42f8');
    });

    it('finds and merges redaction ranges across concatenated text', () => {
      const secret = 'SUPER_SECRET_VALUE_12345';
      const text = `part1_${secret.slice(0, 10)}${secret.slice(10)}_part2`;
      const ranges = findRedactionRangesInText(text, [{ value: secret, kind: 'generic' }]);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual([6, 6 + secret.length]);
    });

    it('redacts secret split across two final events', () => {
      const secret = 'MY_CANONICAL_TARGET_PATH_SECRET';
      const events: AgentEventDraft[] = [
        {
          sessionId: 's1',
          type: 'final',
          timestamp: '2026-08-25T00:00:00.000Z',
          text: `Target prefix: ${secret.slice(0, 15)}`,
        },
        {
          sessionId: 's1',
          type: 'final',
          timestamp: '2026-08-25T00:00:01.000Z',
          text: `${secret.slice(15)} suffix finish`,
        },
      ];

      const redacted = redactNonStreamEvents(events, [{ value: secret, kind: 'generic' }]);
      expect(redacted).toHaveLength(2);
      expect(view(redacted[0])?.text).toBe('Target prefix: [REDACTED]');
      expect(view(redacted[1])?.text).toBe('[REDACTED] suffix finish');

      const leaves = extractPayloadStringLeaves(redacted);
      const combined = leaves.join('');
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(secret.slice(0, 15));
      expect(combined).not.toContain(secret.slice(15));
    });

    it('sanitizes and bounds unvisited deep nodes, wide objects, wide arrays, and secret-named keys', () => {
      const secret = 'HIDDEN_SECRET_KEY_VALUE_12345';
      const deepObject: MutablePortableRecord = {};
      let cursor = deepObject;
      for (let i = 0; i < 10; i += 1) {
        const nested: MutablePortableRecord = {};
        cursor.nested = nested;
        cursor = nested;
      }
      cursor.leaf = `deep_${secret}`;

      // Wide object with api_key first and 200 keys
      const wideObject: MutablePortableRecord = { api_key: 'secret_token_12345' };
      for (let i = 0; i < 200; i += 1) {
        wideObject[`key_${String(i)}`] = `val_${String(i)}_${secret}`;
      }

      // Wide array with 200 elements
      const wideArray: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        wideArray.push(`elem_${String(i)}_${secret}`);
      }

      const events: AgentEventDraft[] = [
        {
          sessionId: 's2',
          type: 'structured',
          timestamp: '2026-08-25T00:00:00.000Z',
          data: {
            deep: deepObject,
            wide: wideObject,
            list: wideArray,
          },
        },
        {
          sessionId: 's2',
          type: 'error',
          timestamp: '2026-08-25T00:00:01.000Z',
          error: {
            __interleafError: true,
            code: 'internal',
            message: `Error with ${secret}`,
          },
        },
      ];

      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      const drained: AgentEventDraft[] = [];
      for (const e of events) drained.push(...redactor.push(e));
      const redacted = [...drained, ...redactor.finish()];

      const leaves = extractPayloadStringLeaves(redacted);
      const combined = leaves.join('');
      expect(combined).not.toContain(secret);
      // Deep leaves beyond depth 6 are pruned/redacted
      const event0Data = view(redacted[0])?.data;
      expect(JSON.stringify(event0Data)).not.toContain(`deep_${secret}`);

      // Wide object has at most 128 keys and api_key is redacted
      const wide = event0Data?.wide;
      if (!isPortableRecord(wide)) throw new Error('the wide fixture object must survive redaction as an object');
      expect(Object.keys(wide).length).toBeLessThanOrEqual(128);
      expect(wide.api_key).toBe('[REDACTED]');

      // Wide array has at most 128 elements
      const list = event0Data?.list;
      if (!isPortableArray(list)) throw new Error('the wide fixture list must survive redaction as an array');
      expect(list.length).toBeLessThanOrEqual(128);

      // Error message is redacted
      expect(view(redacted[1])?.error?.message).toBe('Error with [REDACTED]');
    });
    it('strictly bounds pending memory and drains immediately post-quarantine across thousands of events', () => {
      const secret = 'SECRET_TOKEN_ACROSS_THOUSANDS';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      const allDrained: AgentEventDraft[] = [];
      // Trigger overflow with a structured event whose total data strings exceed MAX_BUFFERED_CHARS (100 properties * 1,200 chars = 120,000 chars)
      const overflowData: Record<string, string> = {};
      for (let i = 0; i < 100; i += 1) {
        overflowData[`key_${String(i)}`] = 'C'.repeat(1_200) + secret;
      }
      const overflowEvent: AgentEventDraft = {
        sessionId: 's-overflow',
        type: 'structured',
        timestamp: new Date().toISOString(),
        data: overflowData,
      };
      allDrained.push(...redactor.push(overflowEvent));

      expect(redactor.isQuarantined).toBe(true);
      expect(redactor.pendingCount).toBe(0);
      expect(redactor.pendingChars).toBe(0);

      // Push 5,000 post-overflow events and verify O(1) pending memory
      for (let i = 0; i < 5_000; i += 1) {
        const drained = redactor.push({
          sessionId: 's-overflow',
          type: 'structured',
          timestamp: new Date().toISOString(),
          data: {
            index: i,
            partial: `Chunk_${String(i)}_${secret.slice(0, 5)}`,
          },
        });
        allDrained.push(...drained);
        expect(redactor.pendingCount).toBe(0);
        expect(redactor.pendingChars).toBe(0);
      }
      allDrained.push(...redactor.finish());

      expect(redactor.isQuarantined).toBe(true);
      expect(redactor.pendingCount).toBe(0);
      expect(allDrained.length).toBe(5_001);
      // All events post-quarantine are redacted
      const combined = extractPayloadStringLeaves(allDrained).join('');
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(secret.slice(0, 5));
    });

    it('sanitizes malicious huge event, deep tree, and circular references on ingress without throwing', () => {
      const secret = 'SECRET_IN_CIRCULAR_PAYLOAD';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      // Circular object & array
      const circularObj: MutablePortableRecord = { key: 'val' };
      circularObj.self = circularObj;
      const circularArr: MutablePortableValue[] = ['item'];
      circularArr.push(circularArr);

      // Huge string (> 100KB)
      const hugeString = 'X'.repeat(120_000) + secret;

      const maliciousEvent: AgentEventDraft = {
        sessionId: 's-malicious',
        type: 'structured',
        timestamp: new Date().toISOString(),
        data: {
          hugeString,
          circularObj,
          circularArr,
        },
      };
      const hugeFinal: AgentEventDraft = {
        sessionId: 's-malicious',
        type: 'final',
        text: hugeString,
        timestamp: new Date().toISOString(),
      };
      expect(() => {
        const drained = [...redactor.push(maliciousEvent), ...redactor.push(hugeFinal)];
        const final = redactor.finish();
        const all = [...drained, ...final];
        const combined = extractPayloadStringLeaves(all).join('');
        expect(combined).not.toContain(secret);
      }).not.toThrow();
    });

    it.each([
      {
        label: 'two fields within a single structured event',
        secret: 'SECRET_SPLIT_IN_STRUCTURED_PAYLOAD_123', cut: 18,
        events: (a: string, b: string): AgentEventDraft[] => [
          { sessionId: 's-struct-1', type: 'structured', timestamp: '2026-08-25T00:00:00.000Z', data: { header: `Bearer ${a}`, payload: `${b}_suffix` } },
        ],
      },
      {
        label: 'multiple structured events',
        secret: 'SECRET_SPLIT_ACROSS_TWO_STRUCTURED_EVENTS_999', cut: 22,
        events: (a: string, b: string): AgentEventDraft[] => [
          { sessionId: 's-struct-2', type: 'structured', timestamp: '2026-08-25T00:00:00.000Z', data: { partA: `prefix_${a}` } },
          { sessionId: 's-struct-2', type: 'structured', timestamp: '2026-08-25T00:00:01.000Z', data: { partB: `${b}_suffix` } },
        ],
      },
      {
        label: 'structured data and error payload (cross-type unit mapping)',
        secret: 'SECRET_SPLIT_ACROSS_DATA_AND_ERROR_888', cut: 20,
        events: (a: string, b: string): AgentEventDraft[] => [
          { sessionId: 's-cross-1', type: 'structured', timestamp: '2026-08-25T00:00:00.000Z', data: { authPrefix: `api_key="${a}` } },
          { sessionId: 's-cross-1', type: 'error', timestamp: '2026-08-25T00:00:01.000Z', error: { __interleafError: true, code: 'internal', message: `${b}" was invalid` } },
        ],
      },
    ])('redacts secret split across $label', ({ secret, cut, events }) => {
      const half1 = secret.slice(0, cut);
      const half2 = secret.slice(cut);
      const input = events(half1, half2);
      const redacted = redactNonStreamEvents(input, [{ value: secret, kind: 'generic' }]);
      expect(redacted).toHaveLength(input.length);
      const combined = extractPayloadStringLeaves(redacted).join('');
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(`${half1}${half2}`);
    });

    it('aborts ingress traversal and immediately quarantines on highly branched event exceeding budget within first 128 keys', () => {
      const secret = 'SECRET_HIGHLY_BRANCHED_OVERFLOW_777';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      // Create an event with 60 keys, each having 2,500 chars (60 * 2,500 = 150,000 chars > MAX_BUFFERED_CHARS)
      const branchedData: Record<string, string> = {};
      for (let i = 0; i < 60; i += 1) {
        branchedData[`key_${String(i)}`] = 'D'.repeat(2_500) + secret;
      }

      const hugeEvent: AgentEventDraft = {
        sessionId: 's-branched-overflow',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: branchedData,
      };

      const drained = redactor.push(hugeEvent);
      expect(redactor.isQuarantined).toBe(true);
      expect(redactor.pendingCount).toBe(0);
      expect(redactor.pendingChars).toBe(0);
      expect(drained).toHaveLength(1);

      // Post-overflow pushes stay at pendingCount=0
      for (let i = 0; i < 100; i += 1) {
        const postDrained = redactor.push({
          sessionId: 's-branched-overflow',
          type: 'stdout',
          stream: 'stdout',
          text: `Post overflow message ${String(i)} with ${secret}\n`,
          timestamp: new Date().toISOString(),
        });
        expect(postDrained).toHaveLength(1);
        expect(redactor.pendingCount).toBe(0);
        expect(redactor.pendingChars).toBe(0);
      }

      const all = [...drained, ...redactor.finish()];
      const leaves = extractPayloadStringLeaves(all);
      const combined = leaves.join('');
      expect(combined).not.toContain(secret);
    });

    it('allows truly payload-free started event to take immediate fast path', () => {
      const secret = 'SECRET_KEY_FOR_EMPTY_STARTED';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      const emptyStarted: AgentEventDraft = {
        sessionId: 's-empty-started',
        type: 'started',
        timestamp: '2026-08-25T00:00:00.000Z',
      };

      const drained = redactor.push(emptyStarted);
      expect(drained).toHaveLength(1);
      expect(drained[0]).toEqual(emptyStarted);
    });

    it('redacts sensitive object keys with collision-safe renaming and preserves safe keys', () => {
      const pathSecret = '/Users/victim/repo';
      const tokenSecret = 'sk-proj-SUPER_SECRET_TOKEN_12345';
      const redactor = new EventRedactor([
        { value: pathSecret, kind: 'path' },
        { value: tokenSecret, kind: 'generic' },
      ]);

      const event: AgentEventDraft = {
        sessionId: 's-key-redaction',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          safe_field: 'normal value',
          [pathSecret]: 'value under path key',
          [`${pathSecret}_duplicate`]: 'second value under path key',
          [tokenSecret]: 'value under token key',
        },
      };

      const drained = redactor.push(event);
      const final = redactor.finish();
      const all = [...drained, ...final];

      expect(all).toHaveLength(1);
      const payloadLeaves = extractPayloadStringLeaves(all);
      const combined = payloadLeaves.join('');
      expect(combined).not.toContain(pathSecret);
      expect(combined).not.toContain(tokenSecret);

      const resultData = view(all[0])?.data;
      expect(resultData).toBeDefined();
      expect(resultData?.safe_field).toBe('normal value');
      // Ensure no collision overwrite occurred: 4 keys were present, 4 keys remain
      expect(Object.keys(resultData ?? {})).toHaveLength(4);
    });

    it('redacts secret split across multiple object keys and across key-to-value boundary', () => {
      const secret1 = 'SECRET_SPLIT_ACROSS_TWO_KEYS_111';
      const halfA = secret1.slice(0, 16);
      const halfB = secret1.slice(16);

      const secret2 = 'SECRET_SPLIT_KEY_TO_VALUE_222';
      const keyHalf = secret2.slice(0, 14);
      const valHalf = secret2.slice(14);

      const redactor = new EventRedactor([
        { value: secret1, kind: 'generic' },
        { value: secret2, kind: 'generic' },
      ]);

      const event: AgentEventDraft = {
        sessionId: 's-key-split',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          [`prefix_${halfA}`]: 'val1',
          [`${halfB}_suffix`]: 'val2',
          [`key_${keyHalf}`]: `${valHalf}_suffix`,
        },
      };

      const all = [...redactor.push(event), ...redactor.finish()];
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(secret1);
      expect(streams.keys.join('')).not.toContain(secret1);
      expect(streams.unified.join('')).not.toContain(secret1);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secret1);
      expect(streams.keys.join('')).not.toContain(`${halfA}${halfB}`);

      expect(streams.values.join('')).not.toContain(secret2);
      expect(streams.keys.join('')).not.toContain(secret2);
      expect(streams.unified.join('')).not.toContain(secret2);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secret2);
      expect(streams.unified.join('')).not.toContain(`${keyHalf}${valHalf}`);
    });

    it('redacts secret split across events from key to value (event1 key -> event2 value)', () => {
      const secret = 'SECRET_SPLIT_EVENT1_KEY_EVENT2_VAL_333';
      const keyHalf = secret.slice(0, 18);
      const valHalf = secret.slice(18);

      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      const event1: AgentEventDraft = {
        sessionId: 's-cross-kv',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          [`prefix_${keyHalf}`]: 'non_secret_v1',
        },
      };

      const event2: AgentEventDraft = {
        sessionId: 's-cross-kv',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: {
          normal_k2: `${valHalf}_suffix`,
        },
      };

      const all = [...redactor.push(event1), ...redactor.push(event2), ...redactor.finish()];
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(secret);
      expect(streams.keys.join('')).not.toContain(secret);
      expect(streams.unified.join('')).not.toContain(secret);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secret);
      expect(streams.unified.join('')).not.toContain(`${keyHalf}${valHalf}`);
    });

    it('redacts secret split across events from value to key (event1 value -> event2 key)', () => {
      const secret = 'SECRET_SPLIT_EVENT1_VAL_EVENT2_KEY_444';
      const valHalf = secret.slice(0, 18);
      const keyHalf = secret.slice(18);

      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      const event1: AgentEventDraft = {
        sessionId: 's-cross-vk',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          normal_k1: `prefix_${valHalf}`,
        },
      };

      const event2: AgentEventDraft = {
        sessionId: 's-cross-vk',
        type: 'structured',
        timestamp: '2026-08-25T00:00:01.000Z',
        data: {
          [`${keyHalf}_suffix`]: 'non_secret_v2',
        },
      };

      const all = [...redactor.push(event1), ...redactor.push(event2), ...redactor.finish()];
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(secret);
      expect(streams.keys.join('')).not.toContain(secret);
      expect(streams.unified.join('')).not.toContain(secret);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secret);
      expect(streams.unified.join('')).not.toContain(`${valHalf}${keyHalf}`);
    });

    it('redacts sensitive keys regardless of primitive value type: number, boolean, null, array, nested object', () => {
      const pathSecret = '/Users/victim/project';
      const envSecret = 'CONFIDENTIAL_CUSTOM_ENV_VALUE_555';

      const redactor = new EventRedactor([
        { value: pathSecret, kind: 'path' },
        { value: envSecret, kind: 'generic' },
      ]);

      const event: AgentEventDraft = {
        sessionId: 's-primitives',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          [pathSecret]: 12345, // number value
          [`${pathSecret}_bool`]: true, // boolean value
          [`${pathSecret}_null`]: null, // null value
          [`${envSecret}_array`]: [1, 2, 'safe'], // array value
          nested: {
            [`${envSecret}_nested`]: false, // nested boolean value
            [`${pathSecret}_nested_num`]: 99.9, // nested number value
          },
        },
      };

      const all = [...redactor.push(event), ...redactor.finish()];
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(pathSecret);
      expect(streams.keys.join('')).not.toContain(pathSecret);
      expect(streams.unified.join('')).not.toContain(pathSecret);
      expect(streams.allRecursiveKeys.join('')).not.toContain(pathSecret);

      expect(streams.values.join('')).not.toContain(envSecret);
      expect(streams.keys.join('')).not.toContain(envSecret);
      expect(streams.unified.join('')).not.toContain(envSecret);
      expect(streams.allRecursiveKeys.join('')).not.toContain(envSecret);

      // Verify primitive values remain intact under their collision-safely renamed keys
      const data = view(all[0])?.data;
      expect(data).toBeDefined();
      const rawValues = Object.values(data ?? {});
      expect(rawValues).toContain(12345);
      expect(rawValues).toContain(true);
      expect(rawValues).toContain(null);
      const nestedObj = rawValues.find(isPortableRecord) ?? {};
      expect(Object.values(nestedObj)).toContain(false);
      expect(Object.values(nestedObj)).toContain(99.9);
    });

    it('erases key channels during quarantine on buffer overflow and post-quarantine events', () => {
      const secretKey = 'CONFIDENTIAL_STRING_IN_OVERFLOW_KEY_666';
      const redactor = new EventRedactor([{ value: secretKey, kind: 'generic' }]);
      // Trigger overflow with a huge structured event containing sensitive keys
      const overflowData: Record<string, string> = {};
      for (let i = 0; i < 100; i += 1) {
        overflowData[`${secretKey}_prop_${String(i)}`] = 'E'.repeat(1_200);
      }

      const overflowEvent: AgentEventDraft = {
        sessionId: 's-overflow-key',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: overflowData,
      };

      const drainedOverflow = redactor.push(overflowEvent);
      expect(redactor.isQuarantined).toBe(true);
      expect(redactor.pendingCount).toBe(0);
      expect(drainedOverflow).toHaveLength(1);

      // Push 50 post-quarantine events with sensitive keys in data and error
      for (let i = 0; i < 50; i += 1) {
        const postDrained = redactor.push({
          sessionId: 's-overflow-key',
          type: 'structured',
          timestamp: new Date().toISOString(),
          data: {
            [`${secretKey}_post_${String(i)}`]: `post_val_${String(i)}`,
            safe_k: 'val',
          },
        });
        expect(postDrained).toHaveLength(1);
        const postErrorDrained = redactor.push({
          sessionId: 's-overflow-key',
          type: 'error',
          timestamp: new Date().toISOString(),
          error: {
            __interleafError: true,
            code: 'internal',
            message: `Error with ${secretKey}`,
          },
        });
        expect(postErrorDrained).toHaveLength(1);
        expect(redactor.pendingCount).toBe(0);
      }

      const all = [...drainedOverflow, ...redactor.finish()];
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(secretKey);
      expect(streams.keys.join('')).not.toContain(secretKey);
      expect(streams.unified.join('')).not.toContain(secretKey);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secretKey);

      // Verify that all quarantined structured events have data replaced with safe fixed object { redacted: true }
      for (const e of all.map(view)) {
        if (e?.data !== undefined) {
          expect(e.data).toEqual({ redacted: true });
        }
        if (e?.error !== undefined) {
          expect(e.error).toEqual({
            __interleafError: true,
            code: 'internal',
            message: '[REDACTED]',
          });
        }
      }
    });

    it('avoids ingress placeholder collision with existing __redacted_key_N properties', () => {
      const secret = 'CONFIDENTIAL_IN_OVERLONG_COLLIDING_KEY_999';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      // Overlong key (> 256 chars)
      const overlongKey1 = 'X'.repeat(300) + secret;
      const overlongKey2 = 'Y'.repeat(300) + secret;

      const event: AgentEventDraft = {
        sessionId: 's-placeholder-collision',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          __redacted_key_0: 'existing_val_0',
          __redacted_key_1: 'existing_val_1',
          [overlongKey1]: 'overlong_val_1',
          [overlongKey2]: 'overlong_val_2',
        },
      };

      const all = [...redactor.push(event), ...redactor.finish()];
      const resultData: PortableRecord = view(all[0])?.data ?? {};

      // All 4 distinct properties must be preserved without overwriting __redacted_key_0 or __redacted_key_1!
      expect(Object.keys(resultData)).toHaveLength(4);
      expect(resultData.__redacted_key_0).toBe('existing_val_0');
      expect(resultData.__redacted_key_1).toBe('existing_val_1');
      expect(resultData.__redacted_key_2).toBe('overlong_val_1');
      expect(resultData.__redacted_key_3).toBe('overlong_val_2');

      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(secret);
      expect(streams.keys.join('')).not.toContain(secret);
      expect(streams.unified.join('')).not.toContain(secret);
      expect(streams.allRecursiveKeys.join('')).not.toContain(secret);
    });

    it('enforces key length and byte limits on ingress and prevents hostile overlong keys', () => {
      const secret = 'CONFIDENTIAL_STRING_IN_OVERLONG_KEY_888';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      // 300-char ASCII key (> 256 chars)
      const overlongAsciiKey = 'K'.repeat(300) + secret;
      // Multibyte key (100 characters of 4-byte unicode = 400 bytes > 256 bytes)
      const multibyteKey = '🔒'.repeat(100);

      const event: AgentEventDraft = {
        sessionId: 's-overlong-keys',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          [overlongAsciiKey]: 'val1',
          [multibyteKey]: 'val2',
          normal_key: 'safe value',
        },
      };

      const all = [...redactor.push(event), ...redactor.finish()];
      const resultData = view(all[0])?.data;
      expect(resultData).toBeDefined();
      expect(Object.keys(resultData ?? {})).toHaveLength(3);
      expect(resultData?.normal_key).toBe('safe value');
      expect(Object.keys(resultData ?? {}).some((k) => k.startsWith('__redacted_key_'))).toBe(true);

      const leaves = extractPayloadStringLeaves(all);
      const combined = leaves.join('');
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain('K'.repeat(300));
    });

    it('sanitizes untrusted signal strings to null while preserving valid OS signals', () => {
      const secret = 'SECRET_ENV_IN_SIGNAL_FIELD';
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      const hostileSignalEvent: AgentEventDraft = {
        sessionId: 's-signal',
        type: 'ended',
        signal: `SIGINT_${secret}`,
        exitCode: null,
        timestamp: '2026-08-25T00:00:00.000Z',
      };

      const drainedHostile = redactor.push(hostileSignalEvent);
      expect(view(drainedHostile[0])?.signal).toBeNull();

      const validSignalEvent: AgentEventDraft = {
        sessionId: 's-signal-valid',
        type: 'ended',
        signal: 'SIGTERM',
        exitCode: null,
        timestamp: '2026-08-25T00:00:01.000Z',
      };

      const drainedValid = redactor.push(validSignalEvent);
      expect(view(drainedValid[0])?.signal).toBe('SIGTERM');
    });

    it('drains sparse safe events promptly in strict FIFO order while holding ambiguous split events', () => {
      const secret = 'SECRET_TOKEN_SPARSE_HOLD_12345';
      const half1 = secret.slice(0, 15);
      const half2 = secret.slice(15);

      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);

      // A lone payload waits for one-event lookbehind.
      const safeStruct = redactor.push({
        sessionId: 's-sparse',
        type: 'structured',
        data: { step: 'init', status: 'ok' },
        timestamp: '2026-08-25T00:00:00.000Z',
      });
      expect(safeStruct).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);

      // Push ambiguous event containing half of secret -> both remain held.
      const ambigEvent = redactor.push({
        sessionId: 's-sparse',
        type: 'structured',
        data: { progress: `Working on ${half1}` },
        timestamp: '2026-08-25T00:00:01.000Z',
      });
      expect(ambigEvent).toHaveLength(0);
      expect(redactor.pendingCount).toBe(2);

      // Push completing event containing second half -> buffered together until terminal/lookahead
      const completingPush = redactor.push({
        sessionId: 's-sparse',
        type: 'structured',
        data: { result: `${half2}_finished` },
        timestamp: '2026-08-25T00:00:02.000Z',
      });
      expect(completingPush).toHaveLength(1);
      expect(view(completingPush[0])?.data?.value).toBeUndefined();
      expect(view(completingPush[0])?.data?.step).toBe('init');
      expect(redactor.pendingCount).toBe(2);

      // Finish drains all buffered events and redacts the split secret across events
      const drainedFinal = redactor.finish();
      expect(drainedFinal).toHaveLength(2);
      expect(redactor.pendingCount).toBe(0);

      const leaves = extractPayloadStringLeaves(drainedFinal);
      const combined = leaves.join('');
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(`${half1}${half2}`);
      expect(view(drainedFinal[0])?.data?.progress).not.toContain(half1);
      expect(view(drainedFinal[1])?.data?.result).not.toContain(half2);
    });

    it.each([
      {
        label: '1-char value tail across values stream',
        secret: 'SECRET_MULTI_REF_VALUES_TAIL_12345',
        first: (prefix: string, tail: string): PortableRecord => ({ part1: `prefix_${prefix}`, part2: tail }),
        second: (suffix: string): AgentEventDraft => ({ sessionId: 's-ambig-tail', timestamp: '2026-08-25T00:00:01.000Z', type: 'structured', data: { part3: `${suffix}_completed` } }),
      },
      {
        label: '1-char key tail across keys stream',
        secret: 'SECRET_MULTI_REF_KEYS_TAIL_67890',
        first: (prefix: string, tail: string): PortableRecord => ({ [`k_${prefix}`]: 'val1', [tail]: 'val2' }),
        second: (suffix: string): AgentEventDraft => ({ sessionId: 's-ambig-tail', timestamp: '2026-08-25T00:00:01.000Z', type: 'structured', data: { [`${suffix}_done`]: 'val3' } }),
      },
      {
        label: '1-char value tail across key->value unified stream',
        secret: 'SECRET_KEY_TO_VAL_AMBIG_TAIL_111',
        first: (prefix: string, tail: string): PortableRecord => ({ [`prefix_${prefix}`]: tail }),
        second: (suffix: string): AgentEventDraft => ({ sessionId: 's-ambig-tail', timestamp: '2026-08-25T00:00:01.000Z', type: 'final', text: `${suffix}_done` }),
      },
      {
        label: '1-char key tail across value->key unified stream',
        secret: 'SECRET_VAL_TO_KEY_AMBIG_TAIL_222',
        first: (prefix: string, tail: string): PortableRecord => ({ normal_field: `prefix_${prefix}`, [tail]: '' }),
        second: (suffix: string): AgentEventDraft => ({ sessionId: 's-ambig-tail', timestamp: '2026-08-25T00:00:01.000Z', type: 'final', text: `${suffix}_done` }),
      },
    ])('holds multi-ref ambiguous prefix with $label', ({ secret, first, second }) => {
      const redactor = new EventRedactor([{ value: secret, kind: 'generic' }]);
      const pushed1 = redactor.push({ sessionId: 's-ambig-tail', type: 'structured', timestamp: '2026-08-25T00:00:00.000Z', data: first(secret.slice(0, 10), secret.slice(10, 11)) });
      expect(pushed1).toHaveLength(0);
      expect(redactor.pendingCount).toBe(1);
      const pushed2 = redactor.push(second(secret.slice(11)));
      const streams = extractPayloadStreams([...pushed1, ...pushed2, ...redactor.finish()]);
      for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) expect(stream.join('')).not.toContain(secret);
    });

    it('holds multi-ref ambiguous prefix of >512-char registered secret with 1-char tail and redacts upon finish', () => {
      const longSecret = 'SECRET_VERY_LONG_TOKEN_'.padEnd(600, 'X987654321_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      expect(longSecret.length).toBeGreaterThan(512);

      const part1 = longSecret.slice(0, 300); // 300 chars
      const part2 = longSecret.slice(300, 450); // 150 chars
      const part3 = longSecret.slice(450, 451); // 1 char tail!
      const remainder = longSecret.slice(451); // 149 chars remaining

      const redactor = new EventRedactor([longSecret]);

      const event1: AgentEventDraft = {
        sessionId: 's-long-secret',
        type: 'structured',
        data: {
          field1: `prefix_${part1}`,
          field2: part2,
          field3: part3, // 1 char tail
        },
        timestamp: '2026-08-25T00:00:00.000Z',
      };

      // Push event1: because part1 + part2 + part3 forms a 451-character prefix of longSecret (>256 chars),
      // it MUST be detected as ambiguous and held in buffer (not drained yet).
      const pushed1 = redactor.push(event1);
      expect(pushed1).toHaveLength(0);

      const event2: AgentEventDraft = {
        sessionId: 's-long-secret',
        type: 'final',
        text: `${remainder}_completed`,
        timestamp: '2026-08-25T00:00:01.000Z',
      };

      const all = [...pushed1, ...redactor.push(event2), ...redactor.finish()];
      expect(all.length).toBeGreaterThanOrEqual(2);
      const streams = extractPayloadStreams(all);
      expect(streams.values.join('')).not.toContain(longSecret);
      expect(streams.unified.join('')).not.toContain(longSecret);
    });

    it('redacts and replaces composite values for broad SECRET_KEY-labelled properties with unknown secrets', () => {
      const unknownToken = 'unknown_secret_token_never_registered_999';
      const unknownPass = 'unknown_password_never_registered_888';
      const unknownCred = 'unknown_credential_nested_777';

      const redactor = new EventRedactor([]);

      // Extra, unexpected members on the error are the point of this case: a
      // provider may attach anything, and none of it may survive redaction.
      // Built as its own value so it keeps those members on the way in.
      const hostileError = {
        __interleafError: true as const,
        code: 'internal' as const,
        message: 'Error message with api_key="err_unknown_token_666"',
        diagnosticSecretBundle: {
          unregisteredSecret: 'unknown_token_in_error_extra_999',
          deepConfig: { innerVal: 'unknown_deep_error_secret' },
        },
        providerCredentialsEnvelope: ['unknown_cred_in_array_888', { token: 'unknown_token_777' }],
        safe_diagnostic_prop: 'safe public error detail',
      };

      const event: AgentEventDraft = {
        sessionId: 's-composite-secrets',
        type: 'structured',
        timestamp: '2026-08-25T00:00:00.000Z',
        data: {
          serviceApiKeyPayload: {
            nested: unknownToken,
            deep: { innerSecret: 'deep_secret_val' },
          },
          nestedSecretMetadata: [unknownPass, 'another_secret', 42],
          userCredentialsEnvelope: {
            user: 'alice',
            token: unknownCred,
          },
          passwordDetails: 98765,
          clientSecretConfig: null,
          safe_prop: 'safe public text',
        },
      };
      const errorEvent: AgentEventDraft = {
        sessionId: 's-composite-secrets',
        type: 'error',
        timestamp: '2026-08-25T00:00:01.000Z',
        error: hostileError,
      };

      const all = [...redactor.push(event), ...redactor.push(errorEvent), ...redactor.finish()];
      const streams = extractPayloadStreams(all);

      expect(streams.values.join('')).not.toContain(unknownToken);
      expect(streams.values.join('')).not.toContain('deep_secret_val');
      expect(streams.values.join('')).not.toContain(unknownPass);
      expect(streams.values.join('')).not.toContain(unknownCred);
      expect(streams.values.join('')).not.toContain('err_unknown_token_666');
      expect(streams.values.join('')).not.toContain('unknown_token_in_error_extra_999');
      expect(streams.values.join('')).not.toContain('unknown_deep_error_secret');
      expect(streams.values.join('')).not.toContain('unknown_cred_in_array_888');
      expect(streams.values.join('')).not.toContain('unknown_token_777');

      expect(streams.keys.join('')).not.toContain('innerSecret');
      expect(streams.keys.join('')).not.toContain('deep_secret_val');
      expect(streams.keys.join('')).not.toContain('unregisteredSecret');
      expect(streams.keys.join('')).not.toContain('deepConfig');
      expect(streams.allRecursiveKeys.join('')).not.toContain('innerSecret');
      expect(streams.allRecursiveKeys.join('')).not.toContain('unregisteredSecret');

      const data: PortableRecord = view(all[0])?.data ?? {};
      expect(data.safe_prop).toBe('safe public text');
      expect(data.serviceApiKeyPayload).toBe('[REDACTED]');
      expect(data.nestedSecretMetadata).toBe('[REDACTED]');
      expect(data.userCredentialsEnvelope).toBe('[REDACTED]');
      expect(data.passwordDetails).toBe('[REDACTED]');
      expect(data.clientSecretConfig).toBe('[REDACTED]');

      const err: PortableRecord = view(all[1])?.error ?? {};
      expect(err.__interleafError).toBe(true);
      expect(err.code).toBe('internal');
      expect(err.safe_diagnostic_prop).toBe('safe public error detail');
      expect(err.diagnosticSecretBundle).toBe('[REDACTED]');
      expect(err.providerCredentialsEnvelope).toBe('[REDACTED]');
    });
  });
  describe('AgentService adversarial execution with custom adapter (no ProcessRunner)', () => {
    it('keeps the canonical path visible when split across two final events', async () => {
      const workDir = await makeWorkDir();

      const canonicalWorkDir = workDir;
      const pathHalf1 = canonicalWorkDir.slice(0, Math.floor(canonicalWorkDir.length / 2));
      const pathHalf2 = canonicalWorkDir.slice(Math.floor(canonicalWorkDir.length / 2));

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-1', ordinal: 0, timestamp: new Date().toISOString() };
        yield { type: 'final', sessionId: 'adv-session-1', ordinal: 1, timestamp: new Date().toISOString(), text: `Path start: ${pathHalf1}` };
        yield { type: 'final', sessionId: 'adv-session-1', ordinal: 2, timestamp: new Date().toISOString(), text: `${pathHalf2} done` };
        yield { type: 'ended', sessionId: 'adv-session-1', ordinal: 3, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await untilSettled(repository, sessionId);

      const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
      expect(emittedCombined).toContain(canonicalWorkDir);

      const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
      expect(persistedCombined).toContain(canonicalWorkDir);

      // The last final event carries the path suffix, visible as-is.
      const session = repository.getSession(sessionId);
      expect(session?.finalReport).toBe(`${pathHalf2} done`);
      await close();
    });


    it('gates credential assignments across AgentService while keeping the canonical path visible', async () => {
      const workDir = await makeWorkDir();

      const pathSuffixGate = scriptGate();
      const authorizationValueGate = scriptGate();
      const passwordValueGate = scriptGate();
      const terminalGate = scriptGate();
      let pathFragment = '';
      let pathSuffix = '';
      const authorizationValue = 'opaque-authorization-credential-42f8';
      const passwordValue = 'opaque-passwd-credential-17c9';

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-short-boundary', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 1,
          timestamp: new Date().toISOString(),
          data: { path_fragment: pathFragment },
        };
        await pathSuffixGate.wait();
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 2,
          timestamp: new Date().toISOString(),
          data: { path_suffix: pathSuffix },
        };
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 3,
          timestamp: new Date().toISOString(),
          data: { authorization_prefix: 'authorization=' },
        };
        await authorizationValueGate.wait();
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 4,
          timestamp: new Date().toISOString(),
          data: { authorization_value: authorizationValue },
        };
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 5,
          timestamp: new Date().toISOString(),
          data: { passwd_prefix: 'passwd=' },
        };
        await passwordValueGate.wait();
        yield {
          type: 'structured',
          sessionId: 'adv-short-boundary',
          ordinal: 6,
          timestamp: new Date().toISOString(),
          data: { passwd_value: passwordValue },
        };
        await terminalGate.wait();
        yield { type: 'ended', sessionId: 'adv-short-boundary', ordinal: 7, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const canonicalWorkDir = await realpath(workDir);
      pathFragment = canonicalWorkDir.slice(0, 1);
      pathSuffix = canonicalWorkDir.slice(1);
      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);
      try {

        await pathSuffixGate.reached;
        expect(receivedEvents.map((event) => event.type)).toEqual(['started']);
        expect(repository.listEvents(sessionId).map((event) => event.type)).toEqual(['started']);

        pathSuffixGate.release();
        await authorizationValueGate.reached;
        // The canonical path is ordinary local diagnostics: its first fragment
        // streams once the suffix resolves the one-event lag.
        expect(receivedEvents.map((event) => event.type)).toEqual(['started', 'structured', 'structured']);
        expect(repository.listEvents(sessionId).map((event) => event.type)).toEqual(['started', 'structured', 'structured']);

        authorizationValueGate.release();
        await passwordValueGate.reached;
        // authorization= and its value stay held while passwd= waits for its value.
        expect(receivedEvents.filter((event) => event.type === 'started')).toHaveLength(1);
        expect(receivedEvents.filter((event) => event.type === 'error')).toHaveLength(0);

        passwordValueGate.release();
        await terminalGate.reached;
        expect(receivedEvents.filter((event) => event.type === 'started')).toHaveLength(1);
        expect(receivedEvents.filter((event) => event.type === 'error')).toHaveLength(0);

        terminalGate.release();
        await untilSettled(repository, sessionId);
        const persistedEvents = repository.listEvents(sessionId);
        expect(receivedEvents.map((event) => event.type)).toEqual([
          'started', 'structured', 'structured', 'structured', 'structured',
          'structured', 'structured', 'ended',
        ]);
        expect(persistedEvents.map((event) => event.type)).toEqual([
          'started', 'structured', 'structured', 'structured', 'structured',
          'structured', 'structured', 'ended',
        ]);
        for (const eventList of [receivedEvents, persistedEvents]) {
          const streams = extractPayloadStreams(eventList);
          expect(streams.values.join('')).toContain(canonicalWorkDir);
          for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) {
            // Local path text stays visible in the value stream; credential
            // assignments stay undisclosed end to end.
            expect(stream.join('')).not.toContain('authorization=');
            expect(stream.join('')).not.toContain(authorizationValue);
            expect(stream.join('')).not.toContain('passwd=');
            expect(stream.join('')).not.toContain(passwordValue);
          }
        }
      } finally {
        await close();
      }
    });

    it('gates built-in and alias one-character splits across AgentService SQLite and subscriptions', async () => {
      const workDir = await makeWorkDir();

      const skSecret = 'sk-abcdefghijklmno';
      const jwtSecret = 'eyJheaderpart.longpayloadpart.signaturepart';
      const privateKeySecret = '-----BEGIN PRIVATE KEY-----\nprivate-key-body-42f8\n-----END PRIVATE KEY-----';
      const bearerSecret = 'Bearer opaque-bearer-value-42f8';
      const authorizationCredential = 'opaque-authorization-credential-42f8';
      const cases = [
        ['case-one', skSecret],
        ['case-two', jwtSecret],
        ['case-three', privateKeySecret],
        ['case-four', bearerSecret],
      ] as const;

      const skSuffixGate = scriptGate();
      const jwtSuffixGate = scriptGate();
      const privateSuffixGate = scriptGate();
      const bearerSuffixGate = scriptGate();
      const authorizationSuffixGate = scriptGate();
      const authorizationCredentialGate = scriptGate();
      const terminalGate = scriptGate();

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-one-event-lag', ordinal: 0, timestamp: new Date().toISOString() };

        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 1,
          timestamp: new Date().toISOString(), data: { case_one: cases[0][1].slice(0, 1) },
        };
        await skSuffixGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 2,
          timestamp: new Date().toISOString(), data: { case_one_suffix: cases[0][1].slice(1) },
        };

        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 3,
          timestamp: new Date().toISOString(), data: { case_two: cases[1][1].slice(0, 1) },
        };
        await jwtSuffixGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 4,
          timestamp: new Date().toISOString(), data: { case_two_suffix: cases[1][1].slice(1) },
        };

        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 5,
          timestamp: new Date().toISOString(), data: { case_three: cases[2][1].slice(0, 1) },
        };
        await privateSuffixGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 6,
          timestamp: new Date().toISOString(), data: { case_three_suffix: cases[2][1].slice(1) },
        };

        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 7,
          timestamp: new Date().toISOString(), data: { case_four: cases[3][1].slice(0, 1) },
        };
        await bearerSuffixGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 8,
          timestamp: new Date().toISOString(), data: { case_four_suffix: cases[3][1].slice(1) },
        };

        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 9,
          timestamp: new Date().toISOString(), data: { case_five: 'a' },
        };
        await authorizationSuffixGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 10,
          timestamp: new Date().toISOString(), data: { case_five_suffix: 'uthorization=' },
        };
        await authorizationCredentialGate.wait();
        yield {
          type: 'structured', sessionId: 'adv-one-event-lag', ordinal: 11,
          timestamp: new Date().toISOString(), data: { case_five_credential: authorizationCredential },
        };
        await terminalGate.wait();
        yield { type: 'ended', sessionId: 'adv-one-event-lag', ordinal: 12, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const labels = (events: readonly AgentEvent[]): string[] => events
        .filter((event) => event.type === 'structured')
        .map((event) => Object.keys(event.data)[0] ?? '');
      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);
      try {

        await skSuffixGate.reached;
        expect(receivedEvents.map((event) => event.type)).toEqual(['started']);
        expect(repository.listEvents(sessionId).map((event) => event.type)).toEqual(['started']);

        skSuffixGate.release();
        await jwtSuffixGate.reached;
        expect(labels(receivedEvents)).not.toContain('case_two');
        expect(labels(repository.listEvents(sessionId))).not.toContain('case_two');

        jwtSuffixGate.release();
        await privateSuffixGate.reached;
        expect(labels(receivedEvents)).not.toContain('case_three');
        expect(labels(repository.listEvents(sessionId))).not.toContain('case_three');

        privateSuffixGate.release();
        await bearerSuffixGate.reached;
        expect(labels(receivedEvents)).not.toContain('case_four');
        expect(labels(repository.listEvents(sessionId))).not.toContain('case_four');

        bearerSuffixGate.release();
        await authorizationSuffixGate.reached;
        expect(labels(receivedEvents)).not.toContain('case_five');
        expect(labels(repository.listEvents(sessionId))).not.toContain('case_five');

        authorizationSuffixGate.release();
        await authorizationCredentialGate.reached;
        // `a` and `uthorization=` are both held until the credential arrives;
        // neither destination can reconstruct the assignment before then.
        expect(labels(receivedEvents)).not.toContain('case_five');
        expect(labels(repository.listEvents(sessionId))).not.toContain('case_five');

        authorizationCredentialGate.release();
        await terminalGate.reached;
        expect(labels(receivedEvents)).toEqual([
          'case_one', 'case_one_suffix', 'case_two', 'case_two_suffix', 'case_three', 'case_three_suffix',
          'case_four', 'case_four_suffix', 'case_five', 'case_five_suffix',
        ]);
        expect(labels(repository.listEvents(sessionId))).toEqual([
          'case_one', 'case_one_suffix', 'case_two', 'case_two_suffix', 'case_three', 'case_three_suffix',
          'case_four', 'case_four_suffix', 'case_five', 'case_five_suffix',
        ]);

        terminalGate.release();
        await untilSettled(repository, sessionId);
        const persistedEvents = repository.listEvents(sessionId);
        expect(labels(receivedEvents)).toEqual([
          'case_one', 'case_one_suffix', 'case_two', 'case_two_suffix', 'case_three', 'case_three_suffix',
          'case_four', 'case_four_suffix', 'case_five', 'case_five_suffix', 'case_five_credential',
        ]);
        expect(labels(persistedEvents)).toEqual(labels(receivedEvents));
        expect(receivedEvents.at(-1)?.type).toBe('ended');
        expect(persistedEvents.at(-1)?.type).toBe('ended');

        for (const eventList of [receivedEvents, persistedEvents]) {
          const streams = extractPayloadStreams(eventList);
          for (const stream of [streams.values, streams.keys, streams.unified, streams.allRecursiveKeys]) {
            const combined = stream.join('');
            expect(combined).not.toContain(skSecret);
            expect(combined).not.toContain(jwtSecret);
            expect(combined).not.toContain(privateKeySecret);
            expect(combined).not.toContain(bearerSecret);
            expect(combined).not.toContain(`authorization=${authorizationCredential}`);
            expect(combined).not.toContain(authorizationCredential);
          }
        }
      } finally {
        await close();
      }
    });



    it('redacts secrets split across structured data fields and across structured events', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'ghp_SPLIT_SECRET_DATA_TOKEN_1234567890';
      process.env.TEST_STRUCT_SECRET = envSecret;

      try {
        const customProfile = inheritingProfile('TEST_STRUCT_SECRET');

        const secretPart1 = envSecret.slice(0, 15);
        const secretPart2 = envSecret.slice(15);

        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-2', ordinal: 0, timestamp: new Date().toISOString() };
          yield {
            type: 'structured',
            sessionId: 'adv-session-2',
            ordinal: 1,
            timestamp: new Date().toISOString(),
            data: {
              thread_id: 'thread-real-session-123',
              fragmentA: `Bearer ${secretPart1}`,
            },
          };
          yield {
            type: 'structured',
            sessionId: 'adv-session-2',
            ordinal: 2,
            timestamp: new Date().toISOString(),
            data: {
              fragmentB: `${secretPart2} finished`,
            },
          };
          yield { type: 'ended', sessionId: 'adv-session-2', ordinal: 3, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        const session = repository.getSession(sessionId);
        expect(session?.providerSessionId).toBe('thread-real-session-123');

        // Check payload string leaf concatenation
        const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
        expect(emittedCombined).not.toContain(envSecret);
        expect(emittedCombined).not.toContain(`${secretPart1}${secretPart2}`);

        const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
        expect(persistedCombined).not.toContain(envSecret);
        expect(persistedCombined).not.toContain(`${secretPart1}${secretPart2}`);
        await close();
      } finally {
        delete process.env.TEST_STRUCT_SECRET;
      }
    });

    it('redacts secrets split across tests message and error payload (cross-type split)', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'sk-proj-SECRET_KEY_FOR_TESTS_123456789';
      process.env.TEST_KEY_SPLIT = envSecret;

      try {
        const customProfile = inheritingProfile('TEST_KEY_SPLIT');

        const secretPart1 = envSecret.slice(0, 16);
        const secretPart2 = envSecret.slice(16);

        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-3', ordinal: 0, timestamp: new Date().toISOString() };
          yield {
            type: 'tests',
            sessionId: 'adv-session-3',
            ordinal: 1,
            timestamp: new Date().toISOString(),
            data: {
              status: 'failed',
              message: `Test failed: api_key="${secretPart1}`,
            },
          };
          yield {
            type: 'error',
            sessionId: 'adv-session-3',
            ordinal: 2,
            timestamp: new Date().toISOString(),
            error: {
              __interleafError: true,
              code: 'internal',
              message: `${secretPart2}" connection timeout`,
            },
          };
          yield { type: 'ended', sessionId: 'adv-session-3', ordinal: 3, exitCode: 1, signal: null, timestamp: new Date().toISOString() };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        // Test result artifact is sanitized
        const artifacts = repository.listArtifacts(sessionId);
        const testArtifact = artifacts.find((a) => a.kind === 'test_result');
        expect(testArtifact).toBeDefined();
        const testJson = JSON.stringify(testArtifact?.metadata);
        expect(testJson).not.toContain(envSecret);

        // Concatenated payload leaves check
        const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
        expect(emittedCombined).not.toContain(envSecret);
        expect(emittedCombined).not.toContain(`${secretPart1}${secretPart2}`);

        const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
        expect(persistedCombined).not.toContain(envSecret);
        expect(persistedCombined).not.toContain(`${secretPart1}${secretPart2}`);
        await close();
      } finally {
        delete process.env.TEST_KEY_SPLIT;
      }
    });

    it('flushes buffered events when the iterator completes without an ended event', async () => {
      const workDir = await makeWorkDir();
      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-4', ordinal: 0, timestamp: new Date().toISOString() };
        yield { type: 'final', sessionId: 'adv-session-4', ordinal: 1, timestamp: new Date().toISOString(), text: 'Report: buffered flush' };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await untilSettled(repository, sessionId);

      expect(receivedEvents.some((e) => e.type === 'final')).toBe(true);
      const session = repository.getSession(sessionId);
      expect(session?.finalReport).not.toBeNull();
      expect(session?.finalReport).toBe('Report: buffered flush');
      const persisted = repository.listEvents(sessionId);
      expect(persisted.some((e) => e.type === 'final')).toBe(true);
      await close();
    });

    it('streams safe started and stdout incrementally before adapter completion release', async () => {
      const workDir = await makeWorkDir();

      const releaseGate = scriptGate();

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-stream-gate', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'stdout',
          sessionId: 'adv-session-stream-gate',
          ordinal: 1,
          stream: 'stdout',
          timestamp: new Date().toISOString(),
          text: 'Building artifacts in progress...\n',
        };
        yield {
          type: 'stdout',
          sessionId: 'adv-session-stream-gate',
          ordinal: 2,
          stream: 'stdout',
          timestamp: new Date().toISOString(),
          text: 'Compiling TypeScript main modules...\n' + 'X'.repeat(500) + '\n',
        };
        // Wait for the gate before completing
        await releaseGate.wait();
        yield { type: 'ended', sessionId: 'adv-session-stream-gate', ordinal: 3, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      // The consumer has processed every event yielded before the gate.
      await releaseGate.reached;

      // Assert started and stdout are ALREADY in subscriptions and SQLite BEFORE releaseGate is resolved!
      expect(receivedEvents.some((e) => e.type === 'started')).toBe(true);
      expect(receivedEvents.some((e) => e.type === 'stdout')).toBe(true);
      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(false);

      const sqliteEventsBefore = repository.listEvents(sessionId);
      expect(sqliteEventsBefore.some((e) => e.type === 'started')).toBe(true);
      expect(sqliteEventsBefore.some((e) => e.type === 'stdout')).toBe(true);
      expect(sqliteEventsBefore.some((e) => e.type === 'ended')).toBe(false);

      // Now release the gate
      releaseGate.release();
      await untilSettled(repository, sessionId);

      // After release, ended is emitted and persisted
      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(true);
      const sqliteEventsAfter = repository.listEvents(sessionId);
      expect(sqliteEventsAfter.some((e) => e.type === 'ended')).toBe(true);

      await close();
    });

    it('persists and emits ended promptly while adapter completion is pending', async () => {
      const workDir = await makeWorkDir();

      const completionHang = scriptGate();

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-ended-gate', ordinal: 0, timestamp: new Date().toISOString() };
        yield { type: 'stdout', sessionId: 'adv-session-ended-gate', ordinal: 1, stream: 'stdout', timestamp: new Date().toISOString(), text: 'Done work\n' };
        yield { type: 'ended', sessionId: 'adv-session-ended-gate', ordinal: 2, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        // Hang completion after yielding ended
        await completionHang.wait();
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await completionHang.reached;

      // Assert ended was ALREADY emitted and persisted in SQLite BEFORE completionHang is resolved!
      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(true);
      const sqliteEventsBefore = repository.listEvents(sessionId);
      expect(sqliteEventsBefore.some((e) => e.type === 'ended')).toBe(true);

      // Release completion hang for child reaping and terminal status persistence
      completionHang.release();
      await untilSettled(repository, sessionId);

      const session = repository.getSession(sessionId);
      expect(session?.status).toBe('completed');

      await close();
    });

    it('preserves strict FIFO arrival order and monotonic ordinals across interleaved stream and non-stream events', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'SECRET_INTERLEAVE_KEY_12345';
      process.env.TEST_INTERLEAVE_SECRET = envSecret;

      try {
        const customProfile = inheritingProfile('TEST_INTERLEAVE_SECRET');

        const secretPart1 = envSecret.slice(0, 12);
        const secretPart2 = envSecret.slice(12);

        // Interleave started -> stdout -> structured -> stderr -> final -> ended
        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-interleave', ordinal: 0, timestamp: new Date().toISOString() };
          yield { type: 'stdout', sessionId: 'adv-session-interleave', ordinal: 1, stream: 'stdout', timestamp: new Date().toISOString(), text: `Starting with secret part: ${secretPart1}` };
          yield { type: 'structured', sessionId: 'adv-session-interleave', ordinal: 2, timestamp: new Date().toISOString(), data: { thread_id: 'sess-abc', part2: secretPart2 } };
          yield { type: 'stderr', sessionId: 'adv-session-interleave', ordinal: 3, stream: 'stderr', timestamp: new Date().toISOString(), text: 'Warning message during execution\n' };
          yield { type: 'final', sessionId: 'adv-session-interleave', ordinal: 4, timestamp: new Date().toISOString(), text: 'Final summary report' };
          yield { type: 'ended', sessionId: 'adv-session-interleave', ordinal: 5, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        // Check exact received order
        const receivedTypes = receivedEvents.map((e) => e.type);
        expect(receivedTypes).toEqual(['started', 'stdout', 'structured', 'stderr', 'final', 'ended']);

        const receivedOrdinals = receivedEvents.map((e) => e.ordinal);
        expect(receivedOrdinals).toEqual([0, 1, 2, 3, 4, 5]);

        // Check SQLite exact order
        const sqliteEvents = repository.listEvents(sessionId);
        const sqliteTypes = sqliteEvents.map((e) => e.type);
        expect(sqliteTypes).toEqual(['started', 'stdout', 'structured', 'stderr', 'final', 'ended']);

        const sqliteOrdinals = sqliteEvents.map((e) => e.ordinal);
        expect(sqliteOrdinals).toEqual([0, 1, 2, 3, 4, 5]);

        // Concatenated payload leaves check: split secret was redacted
        const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
        expect(emittedCombined).not.toContain(envSecret);
        expect(emittedCombined).not.toContain(`${secretPart1}${secretPart2}`);

        const session = repository.getSession(sessionId);
        expect(session?.providerSessionId).toBe('sess-abc');
        expect(session?.finalReport).toBe('Final summary report');
        await close();
      } finally {
        delete process.env.TEST_INTERLEAVE_SECRET;
      }
    });

    it('keeps canonical path visible in a payload-bearing started event and redacts env and error secrets', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'SECRET_STARTED_ENV_TOKEN_987654';
      const errSecret = 'SECRET_STARTED_ERR_PASSWORD_321';
      process.env.TEST_STARTED_SECRET = envSecret;

      try {
        const canonicalWorkDir = workDir;
        const customProfile = inheritingProfile('TEST_STARTED_SECRET');

        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-started-payload', ordinal: 0, timestamp: new Date().toISOString() };
          yield {
            type: 'structured',
            sessionId: 'adv-session-started-payload',
            ordinal: 1,
            timestamp: new Date().toISOString(),
            data: {
              status: `Agent running in ${canonicalWorkDir}`,
              envToken: envSecret,
            },
          };
          yield {
            type: 'error',
            sessionId: 'adv-session-started-payload',
            ordinal: 2,
            timestamp: new Date().toISOString(),
            error: {
              __interleafError: true,
              code: 'internal',
              message: `Startup failed with ${errSecret}`,
            },
          };
          yield { type: 'ended', sessionId: 'adv-session-started-payload', ordinal: 3, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        // Concatenated payload leaves check
        const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
        expect(emittedCombined).toContain(canonicalWorkDir);
        expect(emittedCombined).not.toContain(envSecret);

        const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
        expect(persistedCombined).toContain(canonicalWorkDir);
        expect(persistedCombined).not.toContain(envSecret);

        await close();
      } finally {
        delete process.env.TEST_STARTED_SECRET;
      }
    });

    it('redacts secret split between started event and subsequent structured event in AgentService', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'SECRET_SPLIT_FROM_STARTED_TO_STRUCT_555';
      process.env.TEST_STARTED_SPLIT = envSecret;

      try {
        const customProfile = inheritingProfile('TEST_STARTED_SPLIT');

        const secretPart1 = envSecret.slice(0, 18);
        const secretPart2 = envSecret.slice(18);

        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-started-split', ordinal: 0, timestamp: new Date().toISOString() };
          yield {
            type: 'structured',
            sessionId: 'adv-session-started-split',
            ordinal: 1,
            timestamp: new Date().toISOString(),
            data: {
              status: `Starting with half: ${secretPart1}`,
            },
          };
          yield {
            type: 'structured',
            sessionId: 'adv-session-started-split',
            ordinal: 2,
            timestamp: new Date().toISOString(),
            data: {
              continuation: `${secretPart2} and more text`,
            },
          };
          yield { type: 'ended', sessionId: 'adv-session-started-split', ordinal: 3, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        // Concatenated payload leaves check
        const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
        expect(emittedCombined).not.toContain(envSecret);
        expect(emittedCombined).not.toContain(`${secretPart1}${secretPart2}`);

        const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
        expect(persistedCombined).not.toContain(envSecret);
        expect(persistedCombined).not.toContain(`${secretPart1}${secretPart2}`);

        await close();
      } finally {
        delete process.env.TEST_STARTED_SPLIT;
      }
    });

    it('keeps canonical path keys visible in structured data across SQLite and subscriptions in AgentService', async () => {
      const workDir = await makeWorkDir();

      const canonicalWorkDir = workDir;
      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-keys', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'structured',
          sessionId: 'adv-session-keys',
          ordinal: 1,
          timestamp: new Date().toISOString(),
          data: {
            [canonicalWorkDir]: 'target path key value',
            normal_field: 'safe field value',
          },
        };
        yield { type: 'ended', sessionId: 'adv-session-keys', ordinal: 2, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await untilSettled(repository, sessionId);

      // Concatenated payload leaves check
      const emittedCombined = extractPayloadStringLeaves(receivedEvents).join('');
      expect(emittedCombined).toContain(canonicalWorkDir);
      expect(emittedCombined).toContain('target path key value');

      const persistedCombined = extractPayloadStringLeaves(repository.listEvents(sessionId)).join('');
      expect(persistedCombined).toContain(canonicalWorkDir);
      expect(persistedCombined).toContain('target path key value');

      await close();
    });

    it('sanitizes hostile signal strings to null across SQLite and subscriptions in AgentService', async () => {
      const workDir = await makeWorkDir();

      const envSecret = 'SECRET_IN_SIGNAL_HOSTILE_VALUE_999';
      process.env.TEST_SIGNAL_SECRET = envSecret;

      try {
        const customProfile = inheritingProfile('TEST_SIGNAL_SECRET');

        const adapter = new ScriptedAdapter(async function* () {
          await Promise.resolve();
          yield { type: 'started', sessionId: 'adv-session-signal', ordinal: 0, timestamp: new Date().toISOString() };
          yield {
            type: 'ended',
            sessionId: 'adv-session-signal',
            ordinal: 1,
            exitCode: null,
            signal: `SIGKILL_${envSecret}`,
            timestamp: new Date().toISOString(),
          };
        }, customProfile);

        const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

        await untilSettled(repository, sessionId);

        const endedEvent = receivedEvents.find((e) => e.type === 'ended');
        expect(endedEvent).toBeDefined();
        expect(endedEvent?.signal).toBeNull();

        const sqliteEnded = repository.listEvents(sessionId).find((e) => e.type === 'ended');
        expect(sqliteEnded?.signal).toBeNull();

        await close();
      } finally {
        delete process.env.TEST_SIGNAL_SECRET;
      }
    });

    it('gated sparse safe event delivery: streams structured, changed-files, tests, final, and error progress promptly before release', async () => {
      const workDir = await makeWorkDir();

      const releaseGate = scriptGate();

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-session-sparse-stream', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'structured',
          sessionId: 'adv-session-sparse-stream',
          ordinal: 1,
          timestamp: new Date().toISOString(),
          data: {
            type: 'session.started',
            session_id: 'session-sparse-12345',
            action: 'scan',
            index: 1,
          },
        };
        yield {
          type: 'changed-files',
          sessionId: 'adv-session-sparse-stream',
          ordinal: 2,
          timestamp: new Date().toISOString(),
          data: {
            kind: 'changed-files',
            files: ['src/app.ts', 'src/utils.ts'],
          },
        };
        yield {
          type: 'tests',
          sessionId: 'adv-session-sparse-stream',
          ordinal: 3,
          timestamp: new Date().toISOString(),
          data: {
            status: 'passed',
            message: '12 tests passed successfully',
          },
        };
        yield {
          type: 'final',
          sessionId: 'adv-session-sparse-stream',
          ordinal: 4,
          timestamp: new Date().toISOString(),
          text: 'Execution progress step 4 completed.',
        };
        yield {
          type: 'error',
          sessionId: 'adv-session-sparse-stream',
          ordinal: 5,
          timestamp: new Date().toISOString(),
          error: {
            __interleafError: true,
            code: 'internal',
            message: 'Non-fatal warning encountered during lint',
          },
        };
        // Wait on the gate before completing
        await releaseGate.wait();
        yield { type: 'ended', sessionId: 'adv-session-sparse-stream', ordinal: 6, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      // The consumer has processed all 6 sparse safe events yielded before the gate.
      await releaseGate.reached;

      // The newest payload is intentionally retained as one-event lookbehind;
      // all preceding sparse payloads are already delivered before release.
      const receivedTypes = receivedEvents.map((e) => e.type);
      expect(receivedTypes).toEqual(['started', 'structured', 'changed-files', 'tests', 'final']);
      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(false);

      // Assert SQLite events and artifacts are ALREADY recorded in real time
      const sqliteEvents = repository.listEvents(sessionId);
      const sqliteTypes = sqliteEvents.map((e) => e.type);
      expect(sqliteTypes).toEqual(['started', 'structured', 'changed-files', 'tests', 'final']);

      // Provider session ID extracted
      const sessionBefore = repository.getSession(sessionId);
      expect(sessionBefore?.providerSessionId).toBe('session-sparse-12345');

      // Artifacts created in real time
      const artifactsBefore = repository.listArtifacts(sessionId);
      expect(artifactsBefore.some((a) => a.kind === 'changed_files')).toBe(true);
      expect(artifactsBefore.some((a) => a.kind === 'test_result')).toBe(true);

      // Release gate to let adapter finish
      releaseGate.release();
      await untilSettled(repository, sessionId);

      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(true);
      expect(repository.listEvents(sessionId).some((e) => e.type === 'ended')).toBe(true);

      await close();
    });


    it('AgentService integration: redacts broad SECRET_KEY-labelled composite objects and arrays with unknown secrets', async () => {
      const workDir = await makeWorkDir();

      const unknownToken = 'unknown_token_in_composite_data_999';
      const unknownPass = 'unknown_password_in_composite_list_888';
      const unknownExtra = 'unknown_error_secret_in_composite_777';

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-comp-session', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'structured',
          sessionId: 'adv-comp-session',
          ordinal: 1,
          timestamp: new Date().toISOString(),
          data: {
            serviceApiKeyPayload: {
              nestedKey: unknownToken,
              deepObj: { val: 'inner_deep_val' },
            },
            nestedSecretMetadata: [unknownPass, 'another_secret_item'],
            userCredentialsEnvelope: {
              secretToken: unknownExtra,
            },
            passwordDetails: 98765,
            safe_message: 'Regular safe message',
          },
        };
        yield {
          type: 'ended',
          sessionId: 'adv-comp-session',
          ordinal: 2,
          exitCode: 0,
          signal: null,
          timestamp: new Date().toISOString(),
        };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await untilSettled(repository, sessionId);

      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(true);

      const persistedEvents = repository.listEvents(sessionId);
      expect(persistedEvents.length).toBeGreaterThanOrEqual(3);
      for (const eventList of [persistedEvents, receivedEvents]) {
        const streams = extractPayloadStreams(eventList);
        expect(streams.values.join('')).not.toContain(unknownToken);
        expect(streams.values.join('')).not.toContain('inner_deep_val');
        expect(streams.values.join('')).not.toContain(unknownPass);
        expect(streams.values.join('')).not.toContain(unknownExtra);

        expect(streams.keys.join('')).not.toContain('nestedKey');
        expect(streams.keys.join('')).not.toContain('deepObj');
        expect(streams.keys.join('')).not.toContain('secretToken');

        expect(streams.unified.join('')).not.toContain(unknownToken);
        expect(streams.unified.join('')).not.toContain(unknownPass);
        expect(streams.unified.join('')).not.toContain(unknownExtra);

        expect(streams.allRecursiveKeys.join('')).not.toContain('nestedKey');
        expect(streams.allRecursiveKeys.join('')).not.toContain('secretToken');

        const structured = eventList.find((e) => e.type === 'structured');
        const data: PortableRecord = structured?.data ?? {};
        expect(data.safe_message).toBe('Regular safe message');
        expect(data.serviceApiKeyPayload).toBe('[REDACTED]');
        expect(data.nestedSecretMetadata).toBe('[REDACTED]');
        expect(data.userCredentialsEnvelope).toBe('[REDACTED]');
        expect(data.passwordDetails).toBe('[REDACTED]');
      }

      await close();
    });
    it('AgentService integration: redacts broad SECRET_KEY-labelled composite properties in event.error extras across SQLite and subscriptions', async () => {
      const workDir = await makeWorkDir();

      const unknownErrorToken = 'unknown_token_in_error_extra_bundle_999';
      const unknownErrorPass = 'unknown_pass_in_error_cred_array_888';
      const unknownInnerSecret = 'unknown_inner_secret_in_error_deep_777';

      const adapter = new ScriptedAdapter(async function* () {
        await Promise.resolve();
        yield { type: 'started', sessionId: 'adv-err-session', ordinal: 0, timestamp: new Date().toISOString() };
        yield {
          type: 'error',
          sessionId: 'adv-err-session',
          ordinal: 1,
          timestamp: new Date().toISOString(),
          error: {
            __interleafError: true,
            code: 'internal',
            message: 'External CLI subprocess failure',
            diagnosticSecretBundle: {
              nestedToken: unknownErrorToken,
              deepObj: { innerSecret: unknownInnerSecret },
            },
            providerCredentialsEnvelope: [
              unknownErrorPass,
              { token: 'unknown_token_in_error_array_666' },
            ],
            safe_error_context: 'Diagnostic execution context safe text',
          },
        };
        yield {
          type: 'ended',
          sessionId: 'adv-err-session',
          ordinal: 2,
          exitCode: 1,
          signal: null,
          timestamp: new Date().toISOString(),
        };
      });

      const { repository, receivedEvents, sessionId, close } = await startScriptedSession(adapter, workDir);

      await untilSettled(repository, sessionId);

      expect(receivedEvents.some((e) => e.type === 'ended')).toBe(true);

      const persistedEvents = repository.listEvents(sessionId);
      expect(persistedEvents.length).toBeGreaterThanOrEqual(3);

      for (const eventList of [persistedEvents, receivedEvents]) {
        const streams = extractPayloadStreams(eventList);
        expect(streams.values.join('')).not.toContain(unknownErrorToken);
        expect(streams.values.join('')).not.toContain(unknownErrorPass);
        expect(streams.values.join('')).not.toContain(unknownInnerSecret);
        expect(streams.values.join('')).not.toContain('unknown_token_in_error_array_666');

        expect(streams.keys.join('')).not.toContain('nestedToken');
        expect(streams.keys.join('')).not.toContain('deepObj');
        expect(streams.keys.join('')).not.toContain('innerSecret');

        expect(streams.unified.join('')).not.toContain(unknownErrorToken);
        expect(streams.unified.join('')).not.toContain(unknownErrorPass);
        expect(streams.unified.join('')).not.toContain(unknownInnerSecret);

        expect(streams.allRecursiveKeys.join('')).not.toContain('nestedToken');
        expect(streams.allRecursiveKeys.join('')).not.toContain('innerSecret');

        const errorEvent = eventList.find((e) => e.type === 'error');
        expect(errorEvent).toBeDefined();
        const err: PortableRecord = errorEvent?.error ?? {};
        expect(err.__interleafError).toBe(true);
        expect(err.code).toBe('internal');
        expect(err.message).toBe('External CLI subprocess failure');
        expect(err.safe_error_context).toBe('Diagnostic execution context safe text');
        expect(err.diagnosticSecretBundle).toBe('[REDACTED]');
        expect(err.providerCredentialsEnvelope).toBe('[REDACTED]');
      }

      await close();
    });

  });
});
