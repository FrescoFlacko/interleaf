import { describe, expect, it } from 'vitest';
import { CliAgentAdapter } from '@main/agents/agent-adapter';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { ProcessLauncher } from '@main/agents/process-runner';
import type { AgentProfile } from '@shared/types/agent';
import { adapterCollaborators } from '../helpers/agent-collaborators';

/**
 * Item O: the exact argv every currently supported built-in provider is
 * launched with, pinned against this repository's own evidence
 * (`docs/CLI_CAPABILITIES.md`). Nothing here probes a binary, invokes a model,
 * or asserts a flag the capability document does not record.
 *
 * The defect this covers: a reasoning effort selected for a provider with no
 * evidenced effort flag was silently dropped from argv. The run still happened
 * — at whatever effort the CLI defaults to — while the UI reported the effort
 * the user chose. An unprovable contract must fail closed, not degrade.
 */
type Capture = { readonly file: string; readonly args: readonly string[]; readonly stdin: string | undefined };

function capturingRunner(captured: Capture[]): ProcessLauncher {
  return {
    run: (options) => {
      captured.push({ file: options.file, args: [...options.args], stdin: options.stdin });
      return {
        runId: 'capture',
        events: (async function* () { await Promise.resolve(); })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      };
    },
  };
}

const CAPABILITIES: Record<string, AgentProfile['capabilities']> = {
  codex: { structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true, modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true, subagents: true, interactiveAuthentication: true, nonInteractiveMode: true },
  'claude-code': { structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true, subagents: true, interactiveAuthentication: true, nonInteractiveMode: true },
  antigravity: { structuredOutput: true, sessionResume: false, nativeSandbox: true, workingDirectory: true, modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true, subagents: false, interactiveAuthentication: true, nonInteractiveMode: true },
  copilot: { structuredOutput: false, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: true, reasoningSelection: false, fileChangeEvents: false, toolEvents: false, subagents: false, interactiveAuthentication: true, nonInteractiveMode: false },
  opencode: { structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true, subagents: true, interactiveAuthentication: false, nonInteractiveMode: true },
  cursor: { structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: true, reasoningSelection: false, fileChangeEvents: false, toolEvents: false, subagents: false, interactiveAuthentication: true, nonInteractiveMode: true },
  pi: { structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: true, reasoningSelection: true, fileChangeEvents: false, toolEvents: true, subagents: false, interactiveAuthentication: false, nonInteractiveMode: true },
};

/** Pi's verified unattended preset, in the order its own parser reads it. */
const PI_PRESET = [
  '--print', '--mode', 'json',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  '--no-session', '--no-approve', '--offline',
] as const;

function profile(providerId: keyof typeof CAPABILITIES, defaultArgs: readonly string[], overrides: Partial<MainAgentProfile> = {}): MainAgentProfile {
  const capabilities = CAPABILITIES[providerId];
  if (capabilities === undefined) throw new Error(`Unknown provider fixture: ${providerId}`);
  return {
    id: providerId,
    providerId: providerId as MainAgentProfile['providerId'],
    name: providerId,
    binaryPath: `/usr/local/bin/${providerId}`,
    defaultArgs,
    defaultModel: null,
    reasoningEffort: null,
    permissionMode: 'normal',
    defaultSandboxMode: 'auto-isolated',
    capabilities,
    detection: { availability: 'installed', binaryPath: `/usr/local/bin/${providerId}`, version: 'fixture', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

function adapterFor(launchProfile: MainAgentProfile): { adapter: CliAgentAdapter; captured: Capture[] } {
  const captured: Capture[] = [];
  return { adapter: new CliAgentAdapter(launchProfile, capturingRunner(captured), ...adapterCollaborators()), captured };
}

function startRequest() {
  return {
    documentId: 'doc-1',
    profileId: 'p',
    workingDirectoryHandle: 'h',
    executionMode: 'auto-isolated' as const,
    prompt: 'do the thing',
    model: null,
    contextPacket: null,
    riskConfirmation: null,
    canonicalWorkingDirectory: '/tmp/workspace',
  };
}

describe('built-in provider argv contracts (item O)', () => {
  it.each([
    { providerId: 'codex' as const, defaultArgs: ['exec', '--json', '--sandbox', 'workspace-write'], expected: ['exec', '--json', '--sandbox', 'workspace-write', '-'], stdin: 'do the thing' },
    { providerId: 'claude-code' as const, defaultArgs: ['--print', '--output-format', 'stream-json', '--verbose'], expected: ['--print', '--output-format', 'stream-json', '--verbose'], stdin: 'do the thing' },
    { providerId: 'antigravity' as const, defaultArgs: ['--print', '--output-format', 'stream-json'], expected: ['--print', '--output-format', 'stream-json', 'do the thing'], stdin: undefined },
    { providerId: 'opencode' as const, defaultArgs: ['run', '--format', 'json'], expected: ['run', '--format', 'json', 'do the thing'], stdin: undefined },
    { providerId: 'cursor' as const, defaultArgs: ['--print', '--output-format', 'stream-json'], expected: ['--print', '--output-format', 'stream-json', 'do the thing'], stdin: undefined },
    { providerId: 'pi' as const, defaultArgs: [...PI_PRESET], expected: [...PI_PRESET], stdin: 'do the thing' },
  ])('launches $providerId with exactly its evidenced preset', ({ providerId, defaultArgs, expected, stdin }) => {
    const { adapter, captured } = adapterFor(profile(providerId, defaultArgs));
    adapter.start(startRequest());
    expect(captured).toHaveLength(1);
    expect(captured[0]?.args).toEqual(expected);
    expect(captured[0]?.stdin).toBe(stdin);
    // The prompt is one opaque argv value or stdin; never a shell string.
    expect(captured[0]?.args.filter((arg) => arg === 'do the thing').length).toBeLessThanOrEqual(1);
  });

  it('carries the selected model as exactly one option, replacing any preset value', () => {
    const { adapter, captured } = adapterFor(profile('claude-code', ['--print', '--model', 'preset-model']));
    adapter.start({ ...startRequest(), model: 'claude-opus-5' });
    expect(captured[0]?.args).toEqual(['--print', '--model', 'claude-opus-5']);
  });

  it.each([
    { providerId: 'claude-code' as const, defaultArgs: ['--print'], expected: ['--effort', 'high'] },
    { providerId: 'antigravity' as const, defaultArgs: ['--print'], expected: ['--effort', 'high'] },
    { providerId: 'opencode' as const, defaultArgs: ['run'], expected: ['--variant', 'high'] },
    { providerId: 'pi' as const, defaultArgs: [...PI_PRESET], expected: ['--thinking', 'high'] },
  ])('applies the evidenced reasoning-effort flag for $providerId', ({ providerId, defaultArgs, expected }) => {
    const { adapter, captured } = adapterFor(profile(providerId, defaultArgs, { reasoningEffort: 'high' }));
    adapter.start(startRequest());
    const args = captured[0]?.args ?? [];
    const index = args.indexOf(expected[0]!);
    expect(index, `${providerId} effort flag`).toBeGreaterThanOrEqual(0);
    expect(args.slice(index, index + expected.length)).toEqual(expected);
  });

  /**
   * Codex belongs here, not in the table above. `docs/CLI_CAPABILITIES.md`
   * evidences that Codex accepts generic `-c key=value` overrides; it does not
   * evidence that `model_reasoning_effort` is the key Codex reads for effort.
   * Sending an unverified key would be accepted by the CLI and ignored, running
   * at the provider default while the UI showed the chosen effort — the silent
   * mismatch item O exists to prevent.
   */
  it('refuses to run when a reasoning effort is selected for a provider with no evidenced flag', () => {
    for (const providerId of ['codex', 'cursor', 'copilot'] as const) {
      const { adapter, captured } = adapterFor(profile(providerId, ['--print'], { reasoningEffort: 'high' }));
      expect(() => adapter.start(startRequest()), providerId).toThrow();
      // Fail closed means no process at all, not a run at a silent default.
      expect(captured, providerId).toHaveLength(0);
    }
  });

  it('keeps this Copilot build unavailable for unattended Agent Mode', () => {
    const { adapter, captured } = adapterFor(profile('copilot', ['--stream', 'on']));
    expect(() => adapter.start(startRequest())).toThrow(/unavailable for unattended Agent Mode/iu);
    expect(captured).toHaveLength(0);
  });

  /**
   * Pi has no sandbox and no approval system: a tool-enabled run is unmediated
   * by construction. The containment Interleaf does get comes entirely from
   * the argv preset — no workspace-supplied extensions, skills, prompt
   * templates, themes or context files, no session store, and project trust
   * pinned to "no". A profile missing any of those tokens is a materially
   * weaker run than the one that was evidenced, so it is refused rather than
   * launched.
   */
  it.each([
    { name: 'the project-trust pin', args: PI_PRESET.filter((token) => token !== '--no-approve') },
    { name: 'the JSON event stream', args: PI_PRESET.filter((token) => token !== '--mode' && token !== 'json') },
    { name: 'workspace extension suppression', args: PI_PRESET.filter((token) => token !== '--no-extensions') },
    { name: 'workspace context-file suppression', args: PI_PRESET.filter((token) => token !== '--no-context-files') },
    // Pi's `--print` swallows the token after it unless that token looks like a
    // flag, which is one of the reasons the prompt goes on stdin. A rearranged
    // preset is no longer the argv that was evidenced.
    { name: 'the preset order, putting a value where --print would eat it', args: ['--print', 'summarise the repo', ...PI_PRESET.slice(1)] },
  ])('refuses a Pi run whose arguments drop $name', ({ args }) => {
    const { adapter, captured } = adapterFor(profile('pi', args));
    expect(() => adapter.start(startRequest())).toThrow(/owned by Interleaf/iu);
    expect(captured).toHaveLength(0);
  });

  /**
   * Every one of these passes a "does the preset appear?" check while changing
   * what Pi actually does — each was confirmed against the installed Pi 0.84.4
   * parser (`parseArgs`), read-only and with no model call:
   *
   *   * `--mode text` wins over the preset's `--mode json`, removing the event
   *     stream this integration reads.
   *   * `--extension ./payload.ts` is loaded even though `noExtensions` stays
   *     true, which on a CLI with no sandbox is arbitrary code from settings.
   *   * a second `--print @…` parses into `fileArgs`, a file include that
   *     defeats the stdin-only prompt boundary.
   *   * a bare positional parses into `messages`, a second prompt.
   *   * `--approve`/`-a` forces project trust to "yes".
   */
  it.each([
    { name: 'a text-mode override', extra: ['--mode', 'text'] },
    { name: 'an explicitly named extension', extra: ['--extension', './payload.ts'] },
    { name: 'a second --print with a file include', extra: ['--print', '@/etc/passwd'] },
    { name: 'a bare positional prompt', extra: ['summarise the repo'] },
    { name: 'project-trust approval', extra: ['--approve'] },
    { name: 'the short project-trust spelling', extra: ['-a'] },
    { name: 'an unaccepted thinking level', extra: ['--thinking', 'turbo'] },
    { name: 'a repeated app-owned flag', extra: ['--thinking', 'high', '--thinking', 'low'] },
  ])('refuses a Pi run whose arguments add $name', ({ extra }) => {
    const { adapter, captured } = adapterFor(profile('pi', [...PI_PRESET, ...extra]));
    // Either boundary may speak first — these all arrive in the *stored* argv,
    // which is now refused outright before anything is appended — and what the
    // run must never do is start.
    expect(() => adapter.start(startRequest())).toThrow(/owned by Interleaf|outside its verified contract/iu);
    expect(captured).toHaveLength(0);
  });

  /**
   * Shape is not authority.
   *
   * A trailing `--model <valid-id>` or `--thinking <accepted-level>` pair looks
   * exactly like one this adapter appends, so checking the effective argv alone
   * could not tell a settings-supplied pair from an app-owned one. The app
   * appends a model only when `request.model ?? profile.defaultModel` is
   * non-null, so with both null a stored pair travelled to Pi unchanged while
   * main validated and recorded the *null* effective model: the run's context
   * would go to a model the app never selected, outside its allowlist. The
   * stored argv must therefore be the preset exactly.
   */
  it.each([
    { name: 'an unselected model while the app has none to append', extra: ['--model', 'other/provider'], request: {}, overrides: {} },
    { name: 'an unselected model beside a selected one', extra: ['--model', 'other/provider'], request: { model: 'pi-model-1' }, overrides: {} },
    { name: 'a model when the profile default is also null', extra: ['--model', 'other/provider'], request: { model: null }, overrides: { defaultModel: null } },
    { name: 'a thinking level the profile does not select', extra: ['--thinking', 'high'], request: {}, overrides: { reasoningEffort: null } },
    { name: 'a thinking level beside a selected effort', extra: ['--thinking', 'max'], request: {}, overrides: { reasoningEffort: 'low' } },
  ])('refuses a Pi run whose settings supply $name', ({ extra, request, overrides }) => {
    const { adapter, captured } = adapterFor(profile('pi', [...PI_PRESET, ...extra], overrides));
    expect(() => adapter.start({ ...startRequest(), ...request })).toThrow(/owned by Interleaf/iu);
    // Refused before the spawn, so no context reaches an unselected model.
    expect(captured).toHaveLength(0);
  });

  it.each([
    { name: 'the app-owned model and thinking selections after the preset', overrides: { reasoningEffort: 'high' as const }, model: 'pi-model-1', expected: [...PI_PRESET, '--model', 'pi-model-1', '--thinking', 'high'] },
    { name: 'neither selection when the app has neither to make', overrides: {}, model: null, expected: [...PI_PRESET] },
    { name: 'a profile-default model when the request selects none', overrides: { defaultModel: 'pi-model-2' }, model: null, expected: [...PI_PRESET, '--model', 'pi-model-2'] },
  ])('still carries $name', ({ overrides, model, expected }) => {
    const { adapter, captured } = adapterFor(profile('pi', [...PI_PRESET], overrides));
    adapter.start({ ...startRequest(), model });
    expect(captured[0]?.args).toEqual(expected);
  });

  it('keeps a Pi prompt out of argv entirely, whatever it starts with', () => {
    for (const prompt of ['@/etc/passwd read this', '--help', '-p']) {
      const captured: Capture[] = [];
      new CliAgentAdapter(profile('pi', [...PI_PRESET]), capturingRunner(captured), ...adapterCollaborators())
        .start({ ...startRequest(), prompt });
      expect(captured[0]?.args, prompt).toEqual([...PI_PRESET]);
      expect(captured[0]?.stdin, prompt).toBe(prompt);
    }
  });

  it('refuses resume for every built-in provider that does not declare it', () => {
    for (const providerId of ['claude-code', 'antigravity', 'opencode', 'cursor', 'copilot', 'pi'] as const) {
      const { adapter, captured } = adapterFor(profile(providerId, ['--print']));
      expect(() => adapter.resume('session-1', { ...startRequest(), executionMode: 'isolated-worktree', sessionId: 'session-1' }), providerId)
        .toThrow(/does not support session resume/iu);
      expect(captured, providerId).toHaveLength(0);
    }
  });

  it('resumes Codex with the evidenced argv, including the sandbox override', () => {
    const { adapter, captured } = adapterFor(profile('codex', ['exec', '--json']));
    adapter.resume('01890000-0000-4000-8000-000000000001', {
      ...startRequest(),
      executionMode: 'isolated-worktree',
      sessionId: '01890000-0000-4000-8000-000000000001',
      sandboxArgs: ['-c', 'sandbox_mode="workspace-write"'],
    });
    // `sandbox_mode` stays: it is the evidenced resume override. No effort
    // token appears beside it, because that key is not evidenced.
    expect(captured[0]?.args).toEqual([
      'exec', 'resume', '--json',
      '-c', 'sandbox_mode="workspace-write"',
      '01890000-0000-4000-8000-000000000001', '-',
    ]);
    expect(captured[0]?.stdin).toBe('do the thing');
  });

  it('refuses a Codex resume that carries a reasoning effort, without spawning anything', () => {
    const { adapter, captured } = adapterFor(profile('codex', ['exec', '--json'], { reasoningEffort: 'high' }));
    expect(() => adapter.resume('01890000-0000-4000-8000-000000000001', {
      ...startRequest(),
      executionMode: 'isolated-worktree',
      sessionId: '01890000-0000-4000-8000-000000000001',
      sandboxArgs: [],
      reasoningEffort: 'high',
    })).toThrow(/reasoning-effort contract/iu);
    expect(captured).toHaveLength(0);
  });
});
