import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { CustomAgentEnvironmentOverride, CustomAgentProfile } from '@shared/types/custom-agent-profile';
import {
  toSelectableDefaultExecutionMode,
  type SelectableAgentDefaultExecutionMode,
} from '@shared/constants/agent-mode-selection';
import { useAgentStore } from '../../stores/use-agent-store';
import { bridge } from '../../app/api-client';
import { Select } from '../../components/ui/select';
import {
  CUSTOM_EFFORT_OPTIONS,
  CUSTOM_WORKING_DIRECTORY_OPTIONS,
  DEFAULT_SANDBOX_OPTIONS,
  EXPERT_PROMPT_DELIVERY_OPTIONS,
  PROMPT_DELIVERY_OPTIONS,
  SHELL_FAMILY_OPTIONS,
  STDOUT_PARSING_OPTIONS,
} from './profile-select-options';
import {
  CustomProfileRow,
  EnvironmentOverridesField,
  ExecutionKindCards,
  SettingsCheck,
  SettingsField,
  SettingsGroup,
} from './custom-profile-parts';

const DEFAULT_ARGS = ['--prompt', '{{promptFile}}'];

function linesToTokens(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function tokensToLines(tokens: readonly string[]): string { return tokens.join('\n'); }

export function CustomAgentProfilesPanel(): ReactElement {
  const [profiles, setProfiles] = useState<readonly CustomAgentProfile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [executable, setExecutable] = useState<{ readonly handle: string; readonly displayName: string; readonly fingerprint: string } | null>(null);
  const [executionKind, setExecutionKind] = useState<'normal' | 'expert-shell'>('normal');
  const [shellFamily, setShellFamily] = useState<'posix' | 'powershell' | 'cmd'>('posix');
  const [shellCommand, setShellCommand] = useState('');
  const [resumeShellCommand, setResumeShellCommand] = useState('');
  const [argv, setArgv] = useState(tokensToLines(DEFAULT_ARGS));
  const [promptDeliveryMode, setPromptDeliveryMode] = useState<'stdin' | 'temp-file'>('temp-file');
  const [stdoutParsingMode, setStdoutParsingMode] = useState<'text' | 'json-lines' | 'none'>('text');
  const [defaultModel, setDefaultModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | ''>('');
  const [supportsModelSelection, setSupportsModelSelection] = useState(false);
  const [supportsReasoningSelection, setSupportsReasoningSelection] = useState(false);
  const [resumeArgv, setResumeArgv] = useState('');
  const [supportsResume, setSupportsResume] = useState(false);
  const [defaultSandboxMode, setDefaultSandboxMode] = useState<SelectableAgentDefaultExecutionMode>('auto-isolated');
  const [environmentOverrides, setEnvironmentOverrides] = useState<readonly CustomAgentEnvironmentOverride[]>([]);
  const [unsafe, setUnsafe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const api = bridge.agent;

  const load = useCallback(async (): Promise<void> => {
    try { setProfiles(await api.listCustomProfiles()); } catch { setMessage('Custom profiles could not be loaded.'); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const reset = (): void => {
    setEditingId(null); setName(''); setExecutable(null);
    setExecutionKind('normal'); setShellFamily('posix'); setShellCommand(''); setResumeShellCommand('');
    setArgv(tokensToLines(DEFAULT_ARGS)); setPromptDeliveryMode('temp-file'); setStdoutParsingMode('text');
    setDefaultModel(''); setReasoningEffort('');
    setSupportsModelSelection(false); setSupportsReasoningSelection(false);
    setResumeArgv(''); setSupportsResume(false);
    setDefaultSandboxMode('auto-isolated'); setUnsafe(false);
    setEnvironmentOverrides([]);
  };
  const pickExecutable = async (): Promise<void> => {
    setMessage(null);
    try {
      const selected = await api.selectExecutable();
      if (selected !== null) setExecutable(selected);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The program could not be chosen.'); }
  };

  const edit = (profile: CustomAgentProfile): void => {
    setEditingId(profile.id); setName(profile.name); setExecutable(profile.executable);
    const kind = profile.executionKind;
    setExecutionKind(kind);
    if (kind === 'expert-shell') {
      setShellFamily(profile.shellFamily);
      setShellCommand(profile.shellCommand);
      setResumeShellCommand(profile.resumeShellCommand ?? '');
      setArgv('');
      setResumeArgv('');
      setPromptDeliveryMode('stdin');
    } else {
      setArgv(tokensToLines(profile.argvTemplate));
      setPromptDeliveryMode(profile.promptDeliveryMode);
      setResumeArgv(profile.resumeCommandTemplate ? tokensToLines(profile.resumeCommandTemplate) : '');
      setShellCommand('');
      setResumeShellCommand('');
    }
    setStdoutParsingMode(profile.stdoutParsingMode);
    setDefaultModel(profile.defaultModel ?? '');
    setReasoningEffort(profile.reasoningEffort ?? '');
    setSupportsModelSelection(profile.supportsModelSelection);
    setSupportsReasoningSelection(profile.supportsReasoningSelection);
    setSupportsResume(profile.supportsResume);
    // A legacy `container-sandbox` profile default is editable as the
    // recommended default; the stored value is only replaced if the user saves.
    setDefaultSandboxMode(toSelectableDefaultExecutionMode(profile.defaultSandboxMode));
    setUnsafe(profile.unsafe); setMessage(null);
    setEnvironmentOverrides(profile.environmentOverrides);
  };
  const save = async (): Promise<void> => {
    if (name.trim().length === 0 || executable === null) { setMessage('Add a name and choose a program first.'); return; }
    if (executionKind === 'expert-shell') {
      if (shellCommand.trim().length === 0) { setMessage('Add the shell command to run.'); return; }
      if (supportsResume && resumeShellCommand.trim().length === 0) { setMessage('Add the shell command that resumes a session.'); return; }
    } else {
      if (linesToTokens(argv).length === 0) { setMessage('Add at least one argument.'); return; }
      if (supportsResume && linesToTokens(resumeArgv).length === 0) { setMessage('Add the arguments that resume a session.'); return; }
    }
    setBusy(true); setMessage(null);
    try {
      if (executionKind === 'expert-shell') {
        const expertPayload = {
          name: name.trim(),
          executableHandle: executable.handle,
          executionKind: 'expert-shell' as const,
          shellFamily,
          shellCommand: shellCommand.trim(),
          resumeShellCommand: supportsResume ? resumeShellCommand.trim() : null,
          promptDeliveryMode: 'stdin' as const,
          stdoutParsingMode,
          defaultModel: defaultModel.trim().length > 0 ? defaultModel.trim() : null,
          reasoningEffort: reasoningEffort.length > 0 ? (reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') : null,
          supportsModelSelection,
          supportsReasoningSelection,
          supportsResume,
          defaultSandboxMode,
          workingDirectoryPolicy: 'select-per-run' as const,
          unsafe,
          environmentOverrides: [...environmentOverrides],
        };
        if (editingId === null) await api.createCustomProfile(expertPayload);
        else await api.updateCustomProfile({ id: editingId, ...expertPayload });
      } else {
        const normalPayload = {
          name: name.trim(),
          executableHandle: executable.handle,
          executionKind: 'normal' as const,
          argvTemplate: linesToTokens(argv),
          promptDeliveryMode,
          stdoutParsingMode,
          defaultModel: defaultModel.trim().length > 0 ? defaultModel.trim() : null,
          reasoningEffort: reasoningEffort.length > 0 ? (reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') : null,
          supportsModelSelection,
          supportsReasoningSelection,
          resumeCommandTemplate: supportsResume ? linesToTokens(resumeArgv) : null,
          supportsResume,
          defaultSandboxMode,
          workingDirectoryPolicy: 'select-per-run' as const,
          unsafe,
          environmentOverrides: [...environmentOverrides],
        };
        if (editingId === null) await api.createCustomProfile(normalPayload);
        else await api.updateCustomProfile({ id: editingId, ...normalPayload });
      }
      await load();
      await useAgentStore.getState().refreshProfiles();
      reset(); setMessage('Custom agent profile saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Custom profile could not be saved.'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this custom agent profile? Saved sessions keep their history, but this profile cannot be restored automatically.')) return;
    setBusy(true); setMessage(null);
    try { await api.deleteCustomProfile(id); await load(); await useAgentStore.getState().refreshProfiles(); if (editingId === id) reset(); setMessage('Custom agent profile deleted.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Custom profile could not be deleted.'); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="settings-custom-agent-profiles-heading" className="mt-6 border-t border-border-subtle pt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 id="settings-custom-agent-profiles-heading" className="text-sm font-semibold text-text-primary">Your custom profiles</h4>
          <p className="settings-field-note">Pick the program each profile runs. Interleaf checks it again before every run and refuses a program that has changed since you picked it.</p>
        </div>
        {editingId !== null && <button type="button" onClick={reset} className="settings-outline-button py-2">New profile</button>}
      </div>
      <div className="mt-3 flex flex-col gap-2" aria-label="Saved custom agent profiles">
        {profiles.length === 0 && <p className="settings-env-block settings-field-note">No custom profiles yet.</p>}
        {profiles.map((profile) => <CustomProfileRow key={profile.id} profile={profile} onEdit={() => { edit(profile); }} onDelete={() => { void remove(profile.id); }} />)}
      </div>
      <fieldset className="mt-4 flex min-w-0 flex-col gap-4 rounded-lg border border-border-subtle p-4" disabled={busy}>
        <legend className="px-1 text-xs font-semibold text-text-primary">{editingId === null ? 'Add custom profile' : 'Edit custom profile'}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SettingsField label="Name"><input aria-label="Custom profile name" maxLength={120} value={name} onChange={(event) => { setName(event.target.value); }} className="settings-control" /></SettingsField>
          <div className="settings-field">
            <span className="settings-field-label">Program</span>
            <div className="flex min-w-0 items-stretch gap-2">
              <button type="button" onClick={() => { void pickExecutable(); }} className="settings-outline-button py-2">Choose executable…</button>
              <span className="min-w-0 self-center truncate text-xs text-text-primary" title={executable?.displayName}>{executable?.displayName ?? 'Not selected'}</span>
            </div>
          </div>
          <ExecutionKindCards value={executionKind} onChange={(kind) => { setExecutionKind(kind); if (kind === 'expert-shell') setPromptDeliveryMode('stdin'); }} />

          {executionKind === 'expert-shell' ? (
            <>
              <div className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 p-3 sm:col-span-2" role="alert">
                <strong className="text-xs font-semibold text-danger">Expert shell can do anything your account can</strong>
                <p className="settings-field-note">
                  Your command runs through the chosen shell with your full account permissions, so it can read and change any of your files and reach the network. Running in a copy of the folder keeps edits apart, but it does not contain the program, and Interleaf cannot check what a wrapper script does. The prompt arrives on standard input; run details arrive as environment variables.
                </p>
              </div>
              <SettingsField label="Shell"><Select aria-label="Shell family" value={shellFamily} options={SHELL_FAMILY_OPTIONS} onValueChange={setShellFamily} size="sm" /></SettingsField>
              <SettingsField label="Prompt delivery"><Select aria-label="Prompt delivery mode" value="stdin" disabled options={EXPERT_PROMPT_DELIVERY_OPTIONS} onValueChange={() => undefined} size="sm" /></SettingsField>
              <SettingsField label="Shell command" className="sm:col-span-2" note={<>The shell runs this text as written, with the prompt on standard input. It can read INTERLEAF_SESSION_ID, INTERLEAF_RUN_ID, INTERLEAF_MODEL, INTERLEAF_REASONING_EFFORT and INTERLEAF_WORKING_DIR.</>}>
                <textarea aria-label="Static shell command" rows={4} maxLength={16_384} value={shellCommand} onChange={(e) => { setShellCommand(e.target.value); }} placeholder="e.g. ./my-agent-runner.sh" className="settings-control settings-control--mono resize-y" />
              </SettingsField>
            </>
          ) : (
            <>
              <SettingsField label="Arguments, one per line" className="sm:col-span-2" note={<>Each line is passed to the program as one argument, exactly as written. A placeholder must fill a whole line: {'{{workingDir}}'}, {'{{promptFile}}'}, {'{{sessionId}}'}, {'{{model}}'}, {'{{reasoningEffort}}'}.</>}>
                <textarea aria-label="Custom profile argument template" rows={4} maxLength={16_384} value={argv} onChange={(event) => { setArgv(event.target.value); }} className="settings-control settings-control--mono resize-y" />
              </SettingsField>
              <SettingsField label="Prompt delivery"><Select aria-label="Prompt delivery mode" value={promptDeliveryMode} options={PROMPT_DELIVERY_OPTIONS} onValueChange={setPromptDeliveryMode} size="sm" /></SettingsField>
            </>
          )}
          <SettingsField label="Output format"><Select aria-label="Stdout parsing mode" value={stdoutParsingMode} options={STDOUT_PARSING_OPTIONS} onValueChange={setStdoutParsingMode} size="sm" /></SettingsField>
          <SettingsGroup title="Model and reasoning" className="sm:col-span-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SettingsCheck label="Enable model selection" checked={supportsModelSelection} onChange={setSupportsModelSelection}>Let each run choose a model (the arguments need a {'{{model}}'} line)</SettingsCheck>
              <SettingsCheck label="Enable reasoning selection" checked={supportsReasoningSelection} onChange={setSupportsReasoningSelection}>Let each run choose a reasoning effort (the arguments need a {'{{reasoningEffort}}'} line)</SettingsCheck>
              <SettingsField label="Default model"><input aria-label="Custom profile default model" maxLength={128} value={defaultModel} disabled={!supportsModelSelection} onChange={(event) => { setDefaultModel(event.target.value); }} placeholder="e.g. gpt-4o, claude-3-7-sonnet" className="settings-control" /></SettingsField>
              <SettingsField label="Default reasoning effort"><Select aria-label="Custom profile reasoning effort" value={reasoningEffort} disabled={!supportsReasoningSelection} options={CUSTOM_EFFORT_OPTIONS} onValueChange={setReasoningEffort} size="sm" /></SettingsField>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Session resume" className="sm:col-span-2">
            <SettingsCheck label="Enable session resume" checked={supportsResume} onChange={setSupportsResume}>Let a finished task continue in the same session</SettingsCheck>
            {supportsResume && (executionKind === 'expert-shell' ? (
              <SettingsField label="Resume shell command"><textarea aria-label="Custom profile resume shell command" rows={3} maxLength={16_384} value={resumeShellCommand} onChange={(event) => { setResumeShellCommand(event.target.value); }} placeholder="e.g. ./my-agent-runner.sh --resume" className="settings-control settings-control--mono resize-y" /></SettingsField>
            ) : (
              <SettingsField label="Resume arguments, one per line" note={<>Same rules as the arguments above, and one line must be {'{{sessionId}}'}.</>}><textarea aria-label="Custom profile resume argument template" rows={3} maxLength={16_384} value={resumeArgv} onChange={(event) => { setResumeArgv(event.target.value); }} placeholder="exec&#10;resume&#10;{{sessionId}}&#10;--prompt&#10;{{promptFile}}" className="settings-control settings-control--mono resize-y" /></SettingsField>
            ))}
          </SettingsGroup>

          <SettingsField label="Default run mode"><Select aria-label="Custom profile default isolated mode" value={defaultSandboxMode} options={DEFAULT_SANDBOX_OPTIONS} onValueChange={setDefaultSandboxMode} size="sm" /></SettingsField>
          <SettingsField label="Run folder"><Select aria-label="Custom profile working-directory policy" value="select-per-run" disabled options={CUSTOM_WORKING_DIRECTORY_OPTIONS} onValueChange={() => undefined} size="sm" /></SettingsField>
          <label className="flex items-start gap-2 rounded-lg border border-danger/30 p-3 text-xs sm:col-span-2">
            <input type="checkbox" checked={unsafe} onChange={(event) => { setUnsafe(event.target.checked); }} className="mt-0.5 accent-[color:var(--danger)]" />
            <span className="flex flex-col gap-1"><strong className="font-medium text-danger">Show an extra warning</strong><span className="settings-field-note">Custom profiles are never verified, and every run asks you to confirm first. This only adds a warning; it cannot make the program safe.</span></span>
          </label>
        </div>
        <EnvironmentOverridesField overrides={environmentOverrides} onChange={setEnvironmentOverrides} />
        {message && <p role="status" aria-live="polite" className="settings-field-note">{message}</p>}
        <div className="flex gap-2"><button type="button" disabled={busy || name.trim().length === 0 || executable === null} onClick={() => { void save(); }} className="settings-accent-button">{busy ? 'Saving…' : editingId === null ? 'Add profile' : 'Save profile'}</button>{editingId !== null && <button type="button" disabled={busy} onClick={reset} className="settings-outline-button">Cancel</button>}</div>
      </fieldset>
    </section>
  );
}
