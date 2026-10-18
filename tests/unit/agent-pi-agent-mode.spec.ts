import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRegistry, ALWAYS_UNSAFE_AGENT_PROVIDERS, mapProcessEvents } from '@main/agents/agent-adapter';
import { NativeSandboxCapabilityProber } from '@main/agents/native-sandbox-probe';
import { ProcessRunner, type ProcessRunnerEvent } from '@main/agents/process-runner';
import { PiStreamTranslator, translatePiProcessEvents } from '@main/agents/pi-stream';
import { normalizeAgentEvents } from '../../src/renderer/features/agent/agent-activity';
import type { AgentEvent } from '@shared/types/agent';
import { resolveAgentRiskLevel } from '@shared/constants/agent-risk';
import type { PortableRecord } from '@shared/models/portable';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { silentLogger } from '../helpers/silent-logger';

/**
 * Pi as an unattended Agent Mode provider.
 *
 * Pi 0.84.4 really does support unattended, tool-enabled runs — `--print
 * --mode json` is non-interactive, emits an NDJSON event stream, and never
 * prompts. What it does not have is any sandbox or approval system at all (its
 * own README: "No permission popups"; its `docs/security.md`: "No Built-in
 * Sandbox"). So the honest shape of this feature is: enabled, and permanently
 * routed through the critical-risk path that already exists for dangerous
 * runs. These tests hold that line — that the profile cannot be talked out of
 * being unsafe, that Native Restricted is refused rather than faked, and that
 * the stream and cancellation behaviour is the one that was actually observed
 * rather than the one the event names suggest.
 *
 * Nothing here invokes a model: the stream tests drive a local fixture that
 * replays Pi's documented event shapes.
 */

const PI_PRESET = [
  '--print', '--mode', 'json',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  '--no-session', '--no-approve', '--offline',
];

/**
 * A deterministic stand-in for Pi's `--print --mode json` output.
 *
 * The shapes are copied from the installed Pi 0.84.4 `docs/json.md` event
 * taxonomy; nothing here invokes a model or reaches the network. It is written
 * to a temporary directory rather than kept in the repository so that it stays
 * an ordinary spawned program without needing a lint or TypeScript exemption of
 * its own, the way `tests/fixtures/fake-agent-cli.mjs` does.
 */
const FIXTURE_SOURCE = `// Deterministic stand-in for Pi's \`--print --mode json\` output, used to prove
// how Interleaf maps that event stream and how it cancels such a run. The
// shapes below are the real ones: \`docs/json.md\` for the event envelopes and
// \`@earendil-works/pi-ai\` \`AssistantMessage\` for the message — a \`content\`
// array of \`thinking\`/\`text\`/\`toolCall\` entries, with \`stopReason\` and
// \`errorMessage\` on the message itself. Nothing here invokes a model or
// reaches the network.
//
// Invoked with an argv array by ProcessRunner, never through a shell.
const args = process.argv.slice(2);
const stopReason = args.includes('--errored') ? 'error' : args.includes('--aborted') ? 'aborted' : 'stop';

let stdinText = '';
for await (const chunk of process.stdin) stdinText += chunk.toString('utf8');

const emit = (event) => { process.stdout.write(\`\${JSON.stringify(event)}\\n\`); };
const STAMP = 1730000000000;
const assistant = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'deliberating, which is not the reply' },
    { type: 'text', text: 'Listed the repository root.' },
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'fixture-model',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  timestamp: STAMP,
  ...(stopReason === 'error' ? { errorMessage: 'Provider request failed: 402 insufficient credits' } : {}),
};

emit({ type: 'session', version: 3, id: 'fixture-session', timestamp: new Date(STAMP).toISOString(), cwd: process.cwd() });
emit({ type: 'agent_start' });
emit({ type: 'turn_start' });
// The prompt Pi received, echoed so the stdin contract can be asserted.
emit({ type: 'message_start', message: { role: 'user', content: stdinText, timestamp: STAMP } });
emit({ type: 'message_start', message: { ...assistant, content: [], stopReason: 'pending' } });
// JSON-mode updates are delta-only: no cumulative snapshot, no \`partial\`.
emit({ type: 'message_update', usage: assistant.usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
emit({ type: 'message_update', usage: assistant.usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Listed the ' } });
emit({ type: 'message_update', usage: assistant.usage, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'thinking is not the reply' } });
emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } });
emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: 'README.md', isError: false });

if (args.includes('--flood')) {
  // A long reply: 256 KiB of text deltas, four times the 64 KiB report bound,
  // in fewer frames than ProcessRunner's 256-event queue so none is dropped
  // however slowly the test consumes them. The run keeps going afterwards — a
  // tool runs, a second assistant message streams, and the turn ends — so the
  // test can see that only the over-bound prose stops, not the run.
  const chunk = 'z'.repeat(4096);
  for (let index = 0; index < 64; index += 1) {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk } });
  }
  emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'pwd' } });
  emit({ type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'bash', result: '/repo', isError: false });
  const later = { ...assistant, content: [{ type: 'text', text: 'Later prose.' }], timestamp: STAMP + 1 };
  emit({ type: 'message_start', message: { ...later, content: [], stopReason: 'pending' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Later ' } });
  emit({ type: 'message_end', message: later });
  emit({ type: 'agent_end', messages: [later] });
  // Pipe writes are asynchronous: exit only once everything above is flushed.
  process.stdout.write('', () => { process.exit(0); });
  await new Promise(() => {});
}

if (args.includes('--sleep')) {
  // Stay alive so a cancel has something to terminate. Pi's own print mode
  // installs SIGTERM/SIGHUP handlers and exits 143; this mirrors that.
  process.on('SIGTERM', () => { process.exit(143); });
  process.stderr.write('fixture ready: awaiting termination\\n');
  await new Promise((resolve) => { setTimeout(resolve, 5_000); });
  process.exit(0);
}

emit({ type: 'message_update', usage: assistant.usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'repository root.' } });
emit({ type: 'message_end', message: assistant });
emit({ type: 'turn_end', message: assistant, toolResults: [] });
// Pi's JSON mode exits 0 whatever the turn did: print mode only inspects the
// assistant stop reason in text mode. \`agent_end\` carries only \`messages\`.
emit({ type: 'agent_end', messages: [assistant] });
process.exit(0);
`;

let fixtureDir = '';
let FIXTURE = '';

/** The agent events one fixture run produces, through the production pipeline. */
async function runFixture(extra: readonly string[], prompt = 'summarise the repo'): Promise<readonly AgentEvent[]> {
  const runner = new ProcessRunner();
  const handle = runner.run({
    file: process.execPath,
    args: [FIXTURE, ...PI_PRESET, ...extra],
    cwd: process.cwd(),
    stdin: prompt,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  const events: AgentEvent[] = [];
  for await (const event of mapProcessEvents(translatePiProcessEvents(handle.events))) events.push(event);
  await handle.completion;
  return events;
}

function structuredOfType(events: readonly AgentEvent[], type: string): readonly PortableRecord[] {
  return events
    .filter((event): event is AgentEvent & { data: PortableRecord } => event.type === 'structured')
    .map((event) => event.data)
    .filter((data) => data.type === type);
}


function piSettings(permissionMode: 'normal' | 'workspace-write' | 'unsafe-yolo') {
  return {
    pi: {
      binary: 'pi' as const,
      arguments: PI_PRESET,
      defaultModel: null,
      models: [],
      reasoningEffort: null,
      permissionMode,
      sandboxMode: 'auto-isolated' as const,
      workingDirectoryPolicy: 'select-per-run' as const,
      environmentOverrides: [],
    },
  };
}

async function piProfile(registry = new AgentRegistry(testAgentRegistryOptions())) {
  await registry.detect();
  const profile = registry.listMainProfiles().find((candidate) => candidate.providerId === 'pi');
  if (profile === undefined) throw new Error('Pi profile missing from the built-in registry.');
  return { registry, profile };
}

describe('Pi unattended Agent Mode', () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-fake-pi-'));
    FIXTURE = join(fixtureDir, 'fake-pi-cli.mjs');
    writeFileSync(FIXTURE, FIXTURE_SOURCE, 'utf8');
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('ships the verified argv preset as the built-in profile', async () => {
    const { profile } = await piProfile();
    expect(profile.defaultArgs).toEqual(PI_PRESET);
    // Tools are on by default in Pi; the preset never disables them and never
    // forces project trust.
    expect(profile.defaultArgs).not.toContain('--no-tools');
    expect(profile.defaultArgs).not.toContain('--approve');
    expect(profile.capabilities).toMatchObject({
      nonInteractiveMode: true,
      structuredOutput: true,
      toolEvents: true,
      reasoningSelection: true,
      // Not claimed: Pi has no sandbox, no resume wiring here, and no
      // changed-files discriminator in its event stream.
      nativeSandbox: false,
      sessionResume: false,
      fileChangeEvents: false,
    });
  }, 20_000);

  it('is unsafe by construction, and no permission mode can talk it out of it', async () => {
    const { registry, profile } = await piProfile();
    expect(ALWAYS_UNSAFE_AGENT_PROVIDERS.has('pi')).toBe(true);
    expect(profile.unsafe).toBe(true);

    // A settings apply rebuilds the profile from the stored preference. The
    // safest-looking permission mode must not downgrade the run.
    for (const mode of ['normal', 'workspace-write', 'unsafe-yolo'] as const) {
      registry.applyProfileSettings(piSettings(mode));
      const applied = registry.listMainProfiles().find((candidate) => candidate.providerId === 'pi');
      expect(applied?.unsafe, mode).toBe(true);
    }
  }, 20_000);

  it('carries critical risk into every mode it can run in', async () => {
    const { profile } = await piProfile();
    for (const mode of ['isolated-worktree', 'isolated-copy', 'active-env'] as const) {
      expect(resolveAgentRiskLevel({
        mode,
        dangerousProfile: profile.unsafe,
        unverifiedProfile: profile.isCustom,
      }), mode).toBe('critical');
    }
  }, 20_000);

  it('refuses Native Restricted rather than presenting Pi as sandboxed', async () => {
    const { profile } = await piProfile();
    const prober = new NativeSandboxCapabilityProber({ log: silentLogger, probeCwd: process.cwd() });
    try {
      // Refused statically, before any child is spawned: Pi has no native
      // sandbox contract and the profile is unsafe.
      await expect(prober.verify({
        ...profile,
        detection: { ...profile.detection, availability: 'installed', binaryPath: '/usr/local/bin/pi' },
      })).resolves.toBeNull();
    } finally {
      await prober.close();
    }
  }, 20_000);

  it('delivers the prompt on stdin and surfaces Pi tool activity as a progressing command', async () => {
    const events = await runFixture([], '@/etc/passwd summarise this');

    // The prompt arrived verbatim on stdin — not as an `@` file include, which
    // is what Pi's parser would have made of it in argv.
    const promptEcho = structuredOfType(events, 'message_start');
    expect(JSON.stringify(promptEcho)).toContain('@/etc/passwd summarise this');

    // Pi's tool lifecycle is projected onto the one shape the activity feed
    // renders as a progressing item, keyed by Pi's own tool-call id.
    const commands = structuredOfType(events, 'command_execution');
    expect(commands.length).toBeGreaterThanOrEqual(2);
    expect(commands.every((command) => command.id === 'call-1')).toBe(true);
    expect(commands[0]).toMatchObject({ command: 'ls' });
    expect(commands.at(-1)).toMatchObject({ output: 'README.md', exit_code: 0 });

    // Still not claimed, because Pi still does not send it.
    expect(events.some((event) => event.type === 'changed-files')).toBe(false);
  }, 20_000);

  it('makes the assistant reply visible while it streams, as the authoritative answer, and in rendered activity', async () => {
    const events = await runFixture([]);
    const messages = structuredOfType(events, 'assistant_message');

    // Streamed deltas and the authoritative message share one identity, so the
    // activity feed replaces the partial rather than showing it twice.
    expect(new Set(messages.map((message) => message.id)).size).toBe(1);
    // The two deltas, then the authoritative message. `turn_end` repeats that
    // same message and contributes nothing, and thinking is not the reply.
    expect(messages.map((message) => message.text)).toEqual([
      'Listed the ',
      'Listed the repository root.',
      'Listed the repository root.',
    ]);
    expect(JSON.stringify(messages)).not.toContain('not the reply');

    const finals = events.filter((event) => event.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('Listed the repository root.');

    // Persistence assigns the ordinals the projection keys its items on.
    const activity = normalizeAgentEvents(events.map((event, ordinal) => ({ ...event, ordinal })));

    // One message item, carrying the authoritative text: the streamed partials
    // collapse into it instead of stacking up beside it.
    const activityMessages = activity.filter((item) => item.kind === 'message');
    expect(activityMessages).toHaveLength(1);
    expect(activityMessages[0]).toMatchObject({ text: 'Listed the repository root.' });

    const activityFinals = activity.filter((item) => item.kind === 'final');
    expect(activityFinals).toHaveLength(1);
    expect(activityFinals[0]).toMatchObject({ text: 'Listed the repository root.' });

    // The raw NDJSON Pi writes to stdout stays hidden, so the reply is visible
    // exactly once and not again as an envelope.
    expect(activity.some((item) => item.kind === 'log')).toBe(false);
    expect(activity.some((item) => item.kind === 'error')).toBe(false);
  }, 20_000);

  /**
   * The finding this exists for: Pi's JSON mode exits 0 after an errored turn
   * (installed `dist/modes/print-mode.js` inspects `stopReason` only in text
   * mode), so nothing downstream could tell the run had failed.
   */
  it('reports an errored turn as a failure even though Pi exits 0, and shows it as an error rather than a silent success', async () => {
    const events = await runFixture(['--errored']);
    const ended = events.find((event) => event.type === 'ended');
    expect(ended?.exitCode).toBe(0);

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toContain('insufficient credits');
    // No blind final: a turn that errored does not get to speak for the run.
    expect(events.some((event) => event.type === 'final')).toBe(false);

    const activity = normalizeAgentEvents(events.map((event, ordinal) => ({ ...event, ordinal })));
    const activityErrors = activity.filter((item) => item.kind === 'error');
    expect(activityErrors).toHaveLength(1);
    expect(JSON.stringify(activityErrors)).toContain('insufficient credits');
    expect(activity.some((item) => item.kind === 'final')).toBe(false);
  }, 20_000);

  it('reports an aborted turn as a cancellation rather than a completion', async () => {
    const events = await runFixture(['--aborted']);
    expect(events.find((event) => event.type === 'ended')?.exitCode).toBe(0);
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'final')).toBe(false);
  }, 20_000);

  it('cancels a running Pi turn and ends the run', async () => {
    const runner = new ProcessRunner();
    const handle = runner.run({
      file: process.execPath,
      args: [FIXTURE, ...PI_PRESET, '--sleep'],
      cwd: process.cwd(),
      stdin: 'long task',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const events: AgentEvent[] = [];
    const collected = (async () => {
      for await (const event of mapProcessEvents(translatePiProcessEvents(handle.events))) {
        events.push(event);
        // Cancel as soon as the fixture reports it is running, the same point
        // a user's Stop would land on.
        if (event.type === 'stderr' && event.text.includes('awaiting termination')) handle.cancel();
      }
    })();
    await collected;
    await handle.completion;

    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    // Tool activity emitted before the cancel is still delivered.
    expect(events.some((event) => event.type === 'structured')).toBe(true);
    // A run that was stopped mid-turn has no authoritative answer to report.
    expect(events.some((event) => event.type === 'final')).toBe(false);
  }, 20_000);

  /**
   * The report is authoritative or withheld. These are the cases where the
   * stream is no longer the whole run, driven directly rather than through a
   * process because they are hard to provoke on demand.
   */
  describe('withholds the final report when the stream is not whole', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'the answer' }],
      stopReason: 'stop',
      timestamp: 1730000000000,
    };

    it('after the runner reports dropped frames', () => {
      const translator = new PiStreamTranslator();
      translator.translate({ type: 'message_end', message });
      translator.translate({ kind: 'dropped-events', count: 12 });
      expect(translator.report(0, null)).toBe('');
    });

    it('on a non-zero exit or a signalled death', () => {
      const translator = new PiStreamTranslator();
      translator.translate({ type: 'message_end', message });
      expect(translator.report(0, null)).toBe('the answer');
      expect(translator.report(1, null)).toBe('');
      expect(translator.report(null, 'SIGKILL')).toBe('');
    });

    it('once anything has withheld it, including a later successful turn', () => {
      const translator = new PiStreamTranslator();
      translator.withhold();
      translator.translate({ type: 'message_end', message });
      expect(translator.report(0, null)).toBe('');
    });
  });

  /**
   * Only the latest assistant message, ended with the terminal `stop`, may be
   * the report: preparatory or incomplete text is never presented as final.
   */
  /**
   * Once the report is given up — past the 64 KiB bound, or withheld for any
   * other reason — streamed prose is no longer accumulated or re-projected.
   * Without that, every later delta re-joined and re-measured the whole text,
   * so a 1 MiB reply did over a hundred times its own size in work.
   */
  describe('stops assembling streamed prose once the report is withheld', () => {
    const begin = (translator: PiStreamTranslator, timestamp: number) =>
      translator.translate({ type: 'message_start', message: { role: 'assistant', timestamp, content: [] } });
    const delta = (translator: PiStreamTranslator, body: string) =>
      translator.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: body } });

    it('projects nothing and stores nothing after an explicit withhold, even for a later message', () => {
      const translator = new PiStreamTranslator();
      begin(translator, 1);
      expect(delta(translator, 'before')).toHaveLength(1);
      translator.translate({ kind: 'dropped-events', count: 3 });
      const set = vi.spyOn(Map.prototype, 'set');
      try {
        const after = [...delta(translator, 'y'.repeat(4096)), ...delta(translator, 'y'.repeat(4096))];
        begin(translator, 2);
        after.push(...delta(translator, 'a later message'));
        expect(after).toEqual([]);
        expect(set).not.toHaveBeenCalled();
      } finally {
        set.mockRestore();
      }
    });

    it('stops at the first delta that would cross the bound, counting UTF-8 bytes', () => {
      const translator = new PiStreamTranslator();
      begin(translator, 1);
      // 21,845 three-byte characters: 65,535 bytes, one under the bound.
      const nearly = '\u20ac'.repeat(21_845);
      expect(delta(translator, nearly)).toEqual([
        { kind: 'structured', data: { type: 'assistant_message', id: 'pi-message-1', text: nearly } },
      ]);
      expect(delta(translator, '\u20ac')).toEqual([]);
      expect(delta(translator, 'x')).toEqual([]);
      // The authoritative completed message still shows, but is not the report.
      const frames = translator.translate({
        type: 'message_end',
        message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'short' }] },
      });
      expect(frames).toEqual([{ kind: 'structured', data: { type: 'assistant_message', id: 'pi-message-1', text: 'short' } }]);
      expect(translator.report(0, null)).toBe('');
    });

    it('does work proportional to the reply, not to its square, across the translator boundary', async () => {
      const chunk = 'z'.repeat(4096);
      const payload = 256 * chunk.length;
      const at = '2026-10-14T00:00:00.000Z';
      const frame = (data: PortableRecord): ProcessRunnerEvent => ({ type: 'structured', runId: 'r', data, timestamp: at });
      const flood: ProcessRunnerEvent[] = [
        frame({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } }),
        ...Array.from({ length: 256 }, () => frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk } })),
        frame({ type: 'message_end', message: { role: 'assistant', timestamp: 1, stopReason: 'error', errorMessage: 'quota' } }),
        { type: 'ended', runId: 'r', exitCode: 0, signal: null, timestamp: at },
      ];
      let measured = 0;
      const byteLength = Buffer.byteLength.bind(Buffer);
      const spy = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
        if (typeof value === 'string') measured += value.length;
        return byteLength(value, encoding);
      });
      const out: ProcessRunnerEvent[] = [];
      try {
        for await (const event of translatePiProcessEvents(Readable.from(flood))) out.push(event);
      } finally {
        spy.mockRestore();
      }
      const projected = out.filter((event) => event.type === 'structured' && event.data.type === 'assistant_message');
      // Sixteen 4 KiB deltas fit under 64 KiB; nothing after them is projected.
      expect(projected).toHaveLength(16);
      expect(measured).toBeLessThanOrEqual(2 * payload);
      // Withholding the prose does not hide the turn's error.
      expect(out.map((event) => event.type).slice(-2)).toEqual(['error', 'ended']);
      expect(out.some((event) => event.type === 'structured' && event.data.type === 'final')).toBe(false);
    });

    it('keeps tools, later messages and the error-free outcome through a real flooded run', async () => {
      const events = await runFixture(['--flood']);
      const replies = structuredOfType(events, 'assistant_message');
      // The first message's live text stops at the bound; the later message
      // streams no live text because the run's report is withheld, but its
      // completed text still shows.
      expect(replies.filter((reply) => reply.id === 'pi-message-1730000000000').length).toBeLessThanOrEqual(17);
      expect(replies.filter((reply) => reply.id === 'pi-message-1730000000001')).toEqual([
        { type: 'assistant_message', id: 'pi-message-1730000000001', text: 'Later prose.' },
      ]);
      expect(structuredOfType(events, 'command_execution').map((tool) => tool.id)).toContain('call-2');
      expect(events.some((event) => event.type === 'final')).toBe(false);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'ended', exitCode: 0 });
    }, 20_000);
  });

  describe('reports only the run\'s last word', () => {
    const ended = (timestamp: number, stopReason: string, body: string | null) => ({
      type: 'message_end',
      message: { role: 'assistant', timestamp, stopReason, content: body === null ? [] : [{ type: 'text', text: body }] },
    });

    it.each(['toolUse', 'length', 'deferred', 'pending', 'mystery'])('withholds text ended by %s', (stopReason) => {
      const translator = new PiStreamTranslator();
      translator.translate(ended(1, stopReason, 'I will read files.'));
      expect(translator.report(0, null)).toBe('');
    });

    it('drops an earlier answer when a later message ends empty', () => {
      const translator = new PiStreamTranslator();
      translator.translate(ended(1, 'stop', 'Earlier answer'));
      translator.translate(ended(2, 'stop', null));
      expect(translator.report(0, null)).toBe('');
    });

    it('drops an earlier answer when a later message is over the bound or not terminal', () => {
      const overBound = new PiStreamTranslator();
      overBound.translate(ended(1, 'stop', 'Earlier answer'));
      overBound.translate(ended(2, 'stop', 'x'.repeat(64 * 1024 + 1)));
      expect(overBound.report(0, null)).toBe('');

      const toolUse = new PiStreamTranslator();
      toolUse.translate(ended(1, 'stop', 'Earlier answer'));
      toolUse.translate(ended(2, 'toolUse', 'Let me check one more file.'));
      expect(toolUse.report(0, null)).toBe('');
    });

    it('drops an earlier answer when a later message starts but never ends', () => {
      const translator = new PiStreamTranslator();
      translator.translate(ended(1, 'stop', 'Earlier answer'));
      translator.translate({ type: 'message_start', message: { role: 'assistant', timestamp: 2, stopReason: 'pending', content: [] } });
      expect(translator.report(0, null)).toBe('');
    });

    it('reports a tool-using run\'s closing answer, once, despite the duplicate turn_end', () => {
      const translator = new PiStreamTranslator();
      translator.translate(ended(1, 'toolUse', 'I will read files.'));
      translator.translate(ended(2, 'stop', 'All done.'));
      translator.translate({ ...ended(2, 'stop', 'All done.'), type: 'turn_end' });
      expect(translator.report(0, null)).toBe('All done.');
    });
  });
});
