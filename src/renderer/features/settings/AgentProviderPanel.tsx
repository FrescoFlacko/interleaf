import type { ReactElement } from 'react';
import type { AppSettings } from '@shared/schemas/settings';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { AgentProfileEditor } from '../agent/AgentProfileEditor';
import { findProfileEditorDefinition } from '../agent/profile-preferences';
import { ChatGptSignInButton } from './ChatGptSignInButton';
import type { ProviderRow } from './provider-rows';

export type AgentProviderPanelProps = {
  readonly row: ProviderRow;
  readonly settings: AppSettings;
  /** Runtime profiles from main, carrying each profile's model allowlist. */
  readonly availableProfiles: readonly Pick<AgentProfile, 'id' | 'availableModels'>[];
  /** Adopts main's refreshed profiles after an explicit CLI model re-probe. */
  readonly onProfilesRefreshed: (profiles: readonly AgentProfile[]) => void;
  readonly workingDirectories: readonly AgentWorkingDirectory[];
  readonly onSettingsChange: (next: AppSettings) => void;
  readonly settingsReady: boolean;
  readonly signingInChatGpt: boolean;
  readonly onChatGptSignIn: () => void;
  readonly codexInstalled: boolean;
};

/**
 * How each Reader Chat CLI row describes its subscription and its invocation.
 *
 * Only the account kind and the constrained mode are named: never a binary
 * path, a credential, an account identifier, or raw CLI probe output.
 */
const CONNECTION_COPY: Readonly<Record<string, { readonly account: string; readonly note: string }>> = {
  codex: {
    account: 'ChatGPT subscription',
    note: 'Sign-in is managed by the Codex CLI browser flow. When connected, it answers Reader Chat read-only, without tools.',
  },
  'claude-code': {
    account: 'Anthropic subscription',
    note: 'Authentication is managed by the Claude Code CLI. Reader Chat runs it in safe tool-free mode.',
  },
  pi: {
    account: 'Pi model provider subscription',
    note: 'Authentication is managed by the Pi CLI. Reader Chat runs it in tool-free JSON mode with extensions, skills, sessions and web search disabled.',
  },
  omp: {
    account: 'Omp model provider subscription',
    // Says only what the flags actually enforce. Unlike Pi, Omp has no offline
    // mode, so nothing here claims its own network traffic is suppressed.
    note: 'Authentication is managed by the Omp CLI. Reader Chat runs it in tool-free JSON mode with tools, LSP, extensions, skills, rules and sessions disabled, in an empty app-owned directory. Omp has no offline mode, so it may still make its own network requests; Interleaf grants it no file or tool access.',
  },
};

const FALLBACK_CONNECTION_COPY = CONNECTION_COPY['claude-code'] as { readonly account: string; readonly note: string };

/** Connection block for a provider that also serves Reader Chat (design 5d).
 * Only actions this build actually implements are offered. */
function ConnectionBlock({ row, ...props }: AgentProviderPanelProps): ReactElement {
  const isCodex = row.id === 'codex';
  const copy = CONNECTION_COPY[row.id] ?? FALLBACK_CONNECTION_COPY;
  return (
    <div className="settings-field">
      <span className="settings-field-label">Connection</span>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`provider-dot provider-dot--${row.tone}`} />
        <span className="text-xs text-text-primary">{copy.account}</span>
        <span
          className="settings-field-note"
          {...(isCodex ? { 'data-testid': 'codex-chatgpt-auth-status', 'aria-live': 'polite' as const } : {})}
        >
          {props.settingsReady ? row.statusLabel : 'Checking…'}
        </span>
        {isCodex && (
          <ChatGptSignInButton
            pending={props.signingInChatGpt}
            disabled={!props.settingsReady || props.signingInChatGpt || !props.codexInstalled}
            onSignIn={props.onChatGptSignIn}
          />
        )}
      </div>
      <span className="settings-field-note">{copy.note}</span>
    </div>
  );
}

/**
 * Expanded content for a built-in CLI provider: its Reader Chat connection
 * where it has one, then the agent profile that used to live on its own
 * Settings page (design 5d).
 */
export function AgentProviderPanel(props: AgentProviderPanelProps): ReactElement {
  const definition = findProfileEditorDefinition(props.row.id);
  return (
    <>
      <p className="provider-lede">{props.row.description}</p>
      {props.row.notInstalled && (
        <div className="settings-field" data-testid={`provider-install-guidance-${props.row.id}`}>
          <span className="settings-field-label">Not installed</span>
          <span className="settings-field-note">
            Interleaf did not find {props.row.name} on this computer. Install it with its own installer, then restart Interleaf so it can find it. You can still review this profile now.
          </span>
        </div>
      )}
      {props.row.readerChat
        ? <ConnectionBlock {...props} />
        : (
          <div className="settings-field">
            <span className="settings-field-label">Reader chat</span>
            <span className="settings-field-note">Agent Mode only. This integration has no verified tool-free chat mode, so it never answers Reader Chat.</span>
          </div>
        )}
      {/* A Reader-Chat-only CLI has no agent profile below, so it gets neither
          the editor nor the rule that would separate it from nothing. */}
      {definition !== undefined && (
        <>
          <div className="provider-divider" />
          <AgentProfileEditor
            key={definition.id}
            definition={definition}
            settings={props.settings}
            availableModels={props.availableProfiles.find((profile) => profile.id === definition.id)?.availableModels ?? []}
            onModelsRefreshed={props.onProfilesRefreshed}
            workingDirectories={props.workingDirectories}
            onChange={props.onSettingsChange}
          />
        </>
      )}
    </>
  );
}
