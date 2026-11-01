import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import { normalizeSqliteTimestamp } from '../sqlite-timestamp';
import { InterleafError } from '@shared/errors/interleaf-error';
import { normalizeLegacyStoredAgentEvent } from '@shared/legacy/legacy-agent-error';
import type {
  AgentArtifact,
  AgentCapabilities,
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  AgentProviderId,
  AgentSession,
  AgentSessionDetail,
  AgentSessionStatus,
  AgentEnvironmentLifecycle,
  AgentWorkingDirectory,
} from '@shared/types/agent';
import type { AgentExecutionMode, ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import { agentEventSchema } from '@shared/schemas/agent';
import type { MainAgentProfile } from '../../agents/profile-types';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import { agentEnvironmentReviewSchema } from '@shared/schemas/agent-environment';
import type { RegisteredWorkingDirectory } from '../../agents/working-directory-registry';
import { parseFileIdentity, pickFileIdentity } from '../../security/file-identity';
import {
  parseSessionAuthority,
  parseTargetIdentity,
  serializeSessionAuthority,
  serializeTargetIdentity,
  type PersistedSessionAuthority,
  type PersistedTargetIdentity,
} from '../../agents/session-authority';
import { type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';
type ProfileRow = {
  id: string;
  name: string;
  binary_path: string;
  default_args_json: string;
  default_model: string | null;
  reasoning_effort: string | null;
  permission_mode: string;
  default_sandbox_mode: AgentExecutionMode;
  is_custom: number;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  document_id: string | null;
  profile_id: string;
  target_directory_handle: string;
  canonical_target_path: string;
  isolated_workspace_path: string | null;
  sandbox_mode: ResolvedAgentExecutionMode;
  status: AgentSessionStatus;
  provider_session_id: string | null;
  user_prompt: string;
  context_summary: string | null;
  effective_model: string | null;
  effective_reasoning_effort: string | null;
  final_report: string | null;
  created_at: string;
  updated_at: string;
  event_count: number;
  provider_id: AgentProviderId;
  target_display_name: string;
  environment_json: string | null;
  environment_workspace_path: string | null;
  environment_lifecycle: AgentEnvironmentLifecycle | null;
};

type EventRow = {
  id: string;
  session_id: string;
  ordinal: number;
  event_type: AgentEventType;
  event_json: string;
  created_at: string;
};

type ArtifactRow = {
  id: string;
  session_id: string;
  kind: AgentArtifact['kind'];
  app_relative_path: string | null;
  metadata_json: string;
  created_at: string;
  expires_at: string | null;
};

export type StoredWorkingDirectory = RegisteredWorkingDirectory & {
  readonly displayName: string;
};

export type CreateAgentSessionInput = {
  readonly documentId: string;
  readonly profileId: string;
  readonly providerId: AgentProviderId;
  readonly targetDirectory: AgentWorkingDirectory;
  readonly canonicalTargetPath: string;
  readonly isolatedWorkspacePath?: string | null;
  readonly sandboxMode: ResolvedAgentExecutionMode;
  readonly userPrompt: string;
  readonly contextSummary?: string | null;
  readonly effectiveModel?: string | null;
  readonly effectiveReasoningEffort?: string | null;
  readonly baselineFingerprint: string;
  /** Main-only durable identity/authority snapshot (schema migration 24). */
  readonly targetIdentity: PersistedTargetIdentity;
  readonly authority: PersistedSessionAuthority;
};

/**
 * Main-only session authority record. Never projected through `mapSession`
 * and never returned across the preload bridge.
 */
export type StoredSessionAuthority = {
  readonly targetIdentity: PersistedTargetIdentity | null;
  readonly authority: PersistedSessionAuthority | null;
};

export class AgentRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.ensureEnvironmentColumns();
    this.db.prepare(`
      UPDATE agent_sessions
         SET status = 'interrupted', updated_at = datetime('now', 'utc')
       WHERE status IN ('queued', 'running', 'waiting')
    `).run();
  }

  /** Kept outside the forward migration count so older migration fixtures can
   * still be upgraded deterministically; this additive operation is idempotent. */
  private ensureEnvironmentColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('document_id')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN document_id TEXT REFERENCES documents(id) ON DELETE CASCADE');
    if (!names.has('environment_json')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN environment_json TEXT');
    if (!names.has('environment_workspace_path')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN environment_workspace_path TEXT');
    if (!names.has('environment_updated_at')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN environment_updated_at TEXT');
    if (!names.has('effective_model')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN effective_model TEXT');
    if (!names.has('effective_reasoning_effort')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN effective_reasoning_effort TEXT');
    if (!names.has('target_identity_json')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN target_identity_json TEXT');
    if (!names.has('authority_json')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN authority_json TEXT');
  }

  upsertProfile(profile: MainAgentProfile): void {
    this.db.prepare(`
      INSERT INTO agent_profiles (
        id, name, binary_path, default_args_json, default_model, reasoning_effort,
        permission_mode, default_sandbox_mode, env_reference_json, is_custom, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'utc'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        binary_path = excluded.binary_path,
        default_args_json = excluded.default_args_json,
        default_model = excluded.default_model,
        reasoning_effort = excluded.reasoning_effort,
        permission_mode = excluded.permission_mode,
        default_sandbox_mode = excluded.default_sandbox_mode,
        is_custom = excluded.is_custom,
        updated_at = excluded.updated_at
    `).run(
      profile.id,
      profile.name,
      profile.binaryPath,
      JSON.stringify(profile.defaultArgs),
      profile.defaultModel,
      profile.reasoningEffort,
      profile.permissionMode,
      profile.defaultSandboxMode,
      null,
      profile.isCustom ? 1 : 0,
    );
  }

  listProfiles(): readonly MainAgentProfile[] {
    const rows = this.db.prepare(`
      SELECT id, name, binary_path, default_args_json, default_model, reasoning_effort,
             permission_mode, default_sandbox_mode, is_custom, created_at, updated_at
        FROM agent_profiles ORDER BY is_custom ASC, name COLLATE NOCASE ASC
    `).all() as ProfileRow[];
    return rows.map((row) => {
      let args: PortableValue;
      try { args = parsePortableJson(row.default_args_json); } catch (error) {
        throw new InterleafError('internal', 'Stored agent profile arguments are invalid.', { cause: error instanceof Error ? error : null });
      }
      if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
        throw new InterleafError('internal', 'Stored agent profile arguments are invalid.');
      }
      return {
        id: row.id,
        providerId: providerFromProfileId(row.id),
        name: row.name,
        binaryPath: row.binary_path,
        defaultArgs: args,
        defaultModel: row.default_model,
        reasoningEffort: row.reasoning_effort,
        permissionMode: row.permission_mode,
        defaultSandboxMode: row.default_sandbox_mode,
        capabilities: emptyCapabilities(),
        detection: {
          availability: 'not-installed',
          binaryPath: null,
          version: null,
          checkedAt: row.updated_at,
          errorMessage: null,
        },
        isCustom: row.is_custom === 1,
        unsafe: row.permission_mode.toLowerCase().includes('bypass') || args.includes('--yolo'),
      } satisfies MainAgentProfile;
    });
  }

  createSession(input: CreateAgentSessionInput): AgentSession {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO agent_sessions (
        id, document_id, profile_id, target_directory_handle, canonical_target_path,
        isolated_workspace_path, sandbox_mode, status, user_prompt, context_summary,
        baseline_fingerprint, effective_model, effective_reasoning_effort,
        target_identity_json, authority_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.documentId,
      input.profileId,
      input.targetDirectory.handle,
      input.canonicalTargetPath,
      input.isolatedWorkspacePath ?? null,
      input.sandboxMode,
      input.userPrompt,
      input.contextSummary ?? null,
      input.baselineFingerprint,
      input.effectiveModel ?? null,
      input.effectiveReasoningEffort ?? null,
      serializeTargetIdentity(input.targetIdentity),
      serializeSessionAuthority(input.authority),
    );
    const session = this.getSession(id);
    if (session === null) throw new InterleafError('internal', 'Created agent session could not be loaded.');
    return session;
  }

  updateSession(
    id: string,
    update: {
      readonly status?: AgentSessionStatus;
      readonly providerSessionId?: string | null;
      readonly finalReport?: string | null;
      readonly environment?: AgentSessionEnvironment | null;
      /** Main-only path; never returned through mapSession. */
      readonly environmentWorkspacePath?: string | null;
      readonly environmentState?: AgentEnvironmentLifecycle | null;
    },
  ): void {
    const fields: string[] = [];
    const values: (string | null)[] = [];
    if (update.status !== undefined) { fields.push('status = ?'); values.push(update.status); }
    if (update.providerSessionId !== undefined) { fields.push('provider_session_id = ?'); values.push(update.providerSessionId); }
    if (update.finalReport !== undefined) { fields.push('final_report = ?'); values.push(update.finalReport); }
    if (update.environment !== undefined) { fields.push('environment_json = ?'); values.push(update.environment === null ? null : JSON.stringify(update.environment)); }
    if (update.environmentWorkspacePath !== undefined) { fields.push('environment_workspace_path = ?'); values.push(update.environmentWorkspacePath); }
    if (update.environmentState !== undefined) { fields.push('environment_lifecycle = ?'); values.push(update.environmentState); }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now', 'utc')");
    values.push(id);
    this.db.prepare(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Main-only durable identity/authority lookup for a session. Both fields
   * are `null` when the row predates schema migration 24 or when the stored
   * JSON is missing or unparseable; callers must fail closed on `null` rather
   * than substituting current registry or profile state.
   */
  getSessionAuthority(sessionId: string): StoredSessionAuthority | null {
    const row = this.db.prepare(`
      SELECT target_identity_json, authority_json
        FROM agent_sessions
       WHERE id = ?
    `).get(sessionId) as { target_identity_json: string | null; authority_json: string | null } | undefined;
    if (row === undefined) return null;
    return {
      targetIdentity: parseTargetIdentity(row.target_identity_json),
      authority: parseSessionAuthority(row.authority_json),
    };
  }

  registerWorkingDirectory(input: StoredWorkingDirectory): void {
    this.db.prepare(`
      INSERT INTO allowed_working_directories (handle, canonical_path, display_name, identity_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET canonical_path = excluded.canonical_path,
        display_name = excluded.display_name, identity_json = excluded.identity_json,
        last_validated_at = datetime('now', 'utc')
    `).run(input.handle, input.canonicalPath, input.displayName, JSON.stringify(pickFileIdentity(input)));
  }

  listWorkingDirectories(): readonly StoredWorkingDirectory[] {
    const rows = this.db.prepare(`
      SELECT handle, canonical_path, display_name, identity_json
        FROM allowed_working_directories
       ORDER BY last_validated_at DESC
    `).all() as { handle: string; canonical_path: string; display_name: string; identity_json: string }[];
    return rows.flatMap((row) => {
      const entry = mapWorkingDirectoryRow(row);
      return entry === null ? [] : [entry];
    });
  }

  /** Main-only lookup used when validating renderer-persisted capability
   * handles. The returned record includes canonical identity and must never be
   * sent across the preload bridge. */
  getWorkingDirectory(handle: string): StoredWorkingDirectory | null {
    const row = this.db.prepare(`
      SELECT handle, canonical_path, display_name, identity_json
        FROM allowed_working_directories
       WHERE handle = ?
    `).get(handle) as { handle: string; canonical_path: string; display_name: string; identity_json: string } | undefined;
    return row === undefined ? null : mapWorkingDirectoryRow(row);
  }

  appendEvent(input: AgentEventDraft): AgentEvent {
    const ordinalRow = this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM agent_events WHERE session_id = ?'
    ).get(input.sessionId) as { ordinal: number } | undefined;
    const ordinal = ordinalRow?.ordinal ?? 0;
    const event = agentEventSchema.parse({ ...input, ordinal });
    this.db.prepare(`
      INSERT INTO agent_events (id, session_id, ordinal, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.sessionId, ordinal, input.type, JSON.stringify(event), input.timestamp);
    return event;
  }

  addArtifact(input: {
    readonly sessionId: string;
    readonly kind: AgentArtifact['kind'];
    readonly appRelativePath?: string | null;
    readonly metadata: PortableRecord;
    readonly expiresAt?: string | null;
  }): AgentArtifact {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata);
    if (Buffer.byteLength(metadataJson, 'utf8') > 65_536) {
      throw new InterleafError('validation', 'Agent artifact metadata is too large.');
    }
    this.db.prepare(`
      INSERT INTO agent_artifacts (id, session_id, kind, app_relative_path, metadata_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.kind, input.appRelativePath ?? null, metadataJson, createdAt, input.expiresAt ?? null);
    return {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      metadata: input.metadata,
      createdAt,
      expiresAt: input.expiresAt ?? null,
    };
  }

  /** Remove expired context references together with their filesystem packet. */
  expireContextArtifacts(now = new Date().toISOString()): void {
    this.db.prepare(`
      DELETE FROM agent_artifacts
       WHERE kind = 'context_packet'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
    `).run(now);
  }

  deleteContextArtifacts(sessionId: string): void {
    this.db.prepare(`DELETE FROM agent_artifacts WHERE session_id = ? AND kind = 'context_packet'`).run(sessionId);
  }

  getSession(id: string): AgentSession | null {
    const row = this.sessionRow(id);
    return row === undefined ? null : mapSession(row);
  }

  getSessionDetail(id: string): AgentSessionDetail | null {
    const session = this.getSession(id);
    if (session === null) return null;
    return {
      ...session,
      events: this.listEvents(id),
      artifacts: this.listArtifacts(id),
    };
  }

  getSessionDetailForDocument(id: string, documentId: string): AgentSessionDetail | null {
    const row = this.sessionRowForDocument(id, documentId);
    if (row === undefined) return null;
    const session = mapSession(row);
    return {
      ...session,
      events: this.listEvents(id),
      artifacts: this.listArtifacts(id),
    };
  }

  listSessions(documentId: string): readonly AgentSession[] {
    const rows = this.db.prepare(`
        SELECT s.id, s.document_id, s.profile_id, s.target_directory_handle, s.canonical_target_path,
               s.isolated_workspace_path, s.sandbox_mode, s.status, s.provider_session_id,
               s.user_prompt, s.context_summary, s.effective_model, s.effective_reasoning_effort,
               s.final_report, s.created_at, s.updated_at,
               s.environment_json, s.environment_workspace_path,
               s.environment_lifecycle,
               p.id AS provider_id, d.display_name AS target_display_name,
               (SELECT COUNT(*) FROM agent_events e WHERE e.session_id = s.id) AS event_count
          FROM agent_sessions s
          JOIN agent_profiles p ON p.id = s.profile_id
          JOIN allowed_working_directories d ON d.handle = s.target_directory_handle
         WHERE s.document_id = ? AND s.document_id IS NOT NULL
         ORDER BY s.created_at DESC LIMIT 100
      `).all(documentId) as SessionRow[];
    return rows.map((row) => mapSession(row));
  }

  listEvents(sessionId: string, limit = 500): readonly AgentEvent[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, ordinal, event_type, event_json, created_at FROM (SELECT id, session_id, ordinal, event_type, event_json, created_at FROM agent_events WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?) ORDER BY ordinal ASC'
    ).all(sessionId, Math.max(1, Math.min(limit, 500))) as EventRow[];
    return rows.map((row) => {
      try {
        // Sessions recorded before the Interleaf rename hold an error payload
        // with the legacy marker key; normalizing on read keeps that history
        // readable. Writes always produce the current marker.
        const value: PortableValue = normalizeLegacyStoredAgentEvent(parsePortableJson(row.event_json));
        return agentEventSchema.parse(value);
      } catch (error) {
        throw new InterleafError('internal', 'Stored agent event is invalid.', { cause: error instanceof Error ? error : null });
      }
    });
  }

  listArtifacts(sessionId: string): readonly AgentArtifact[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, kind, app_relative_path, metadata_json, created_at, expires_at FROM (SELECT id, session_id, kind, app_relative_path, metadata_json, created_at, expires_at FROM agent_artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT 500) ORDER BY created_at ASC'
    ).all(sessionId) as ArtifactRow[];
    return rows.map((row) => {
      let metadata: PortableValue;
      try { metadata = parsePortableJson(row.metadata_json); } catch (error) {
        throw new InterleafError('internal', 'Stored agent artifact metadata is invalid.', { cause: error instanceof Error ? error : null });
      }
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata) || JSON.stringify(metadata).length > 65_536) {
        throw new InterleafError('internal', 'Stored agent artifact metadata is invalid.');
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        metadata: metadata as PortableRecord,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    });
  }

  private sessionRow(id: string): SessionRow | undefined {
    return this.db.prepare(`
      SELECT s.id, s.document_id, s.profile_id, s.target_directory_handle, s.canonical_target_path,
             s.isolated_workspace_path, s.sandbox_mode, s.status, s.provider_session_id,
             s.user_prompt, s.context_summary, s.effective_model, s.effective_reasoning_effort,
             s.final_report, s.created_at, s.updated_at,
             s.environment_json, s.environment_workspace_path,
             s.environment_lifecycle,
             p.id AS provider_id, d.display_name AS target_display_name,
             (SELECT COUNT(*) FROM agent_events e WHERE e.session_id = s.id) AS event_count
        FROM agent_sessions s
        JOIN agent_profiles p ON p.id = s.profile_id
        JOIN allowed_working_directories d ON d.handle = s.target_directory_handle
       WHERE s.id = ? AND s.document_id IS NOT NULL
    `).get(id) as SessionRow | undefined;
  }

  private sessionRowForDocument(id: string, documentId: string): SessionRow | undefined {
    return this.db.prepare(`
      SELECT s.id, s.document_id, s.profile_id, s.target_directory_handle, s.canonical_target_path,
             s.isolated_workspace_path, s.sandbox_mode, s.status, s.provider_session_id,
             s.user_prompt, s.context_summary, s.effective_model, s.effective_reasoning_effort,
             s.final_report, s.created_at, s.updated_at,
             s.environment_json, s.environment_workspace_path,
             s.environment_lifecycle,
             p.id AS provider_id, d.display_name AS target_display_name,
             (SELECT COUNT(*) FROM agent_events e WHERE e.session_id = s.id) AS event_count
        FROM agent_sessions s
        JOIN agent_profiles p ON p.id = s.profile_id
        JOIN allowed_working_directories d ON d.handle = s.target_directory_handle
       WHERE s.id = ? AND s.document_id = ?
    `).get(id, documentId) as SessionRow | undefined;
  }
}

/**
 * Profile ids that name a known provider. Anything else, including the
 * `custom:<name>` ids user-defined profiles carry, is a custom provider.
 */
const PROVIDER_BY_PROFILE_ID: Readonly<Record<string, AgentProviderId>> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  antigravity: 'antigravity',
  copilot: 'copilot',
  opencode: 'opencode',
  pi: 'pi',
  cursor: 'cursor',
  fake: 'fake',
  custom: 'custom',
};

/**
 * One `allowed_working_directories` row, or `null` when its identity is
 * unreadable. A row recorded before birth time existed carries an explicit
 * `birthtimeNs: null` (migration 26) and stays readable; the registry then
 * refuses to resolve it until the folder is selected again.
 */
function mapWorkingDirectoryRow(row: { handle: string; canonical_path: string; display_name: string; identity_json: string }): StoredWorkingDirectory | null {
  let value: PortableValue;
  try { value = parsePortableJson(row.identity_json); } catch { return null; }
  const identity = parseFileIdentity(value);
  if (identity === null) return null;
  return { handle: row.handle, canonicalPath: row.canonical_path, displayName: row.display_name, ...identity };
}

function providerFromProfileId(id: string): AgentProviderId {
  // `Object.hasOwn` first: a bare object literal inherits `Object.prototype`, so
  // ids such as `constructor` or `toString` would otherwise resolve to inherited
  // functions instead of falling through to `custom`.
  if (!Object.hasOwn(PROVIDER_BY_PROFILE_ID, id)) return 'custom';
  return PROVIDER_BY_PROFILE_ID[id] ?? 'custom';
}

function emptyCapabilities(): AgentCapabilities {
  return {
    structuredOutput: false,
    sessionResume: false,
    nativeSandbox: false,
    workingDirectory: true,
    modelSelection: false,
    reasoningSelection: false,
    fileChangeEvents: false,
    toolEvents: false,
    subagents: false,
    interactiveAuthentication: false,
    nonInteractiveMode: true,
  };
}

function mapSession(row: SessionRow): AgentSession {
  if (row.document_id === null) {
    throw new InterleafError('internal', 'Agent session is not bound to a document.');
  }
  const targetDirectory: AgentWorkingDirectory = {
    handle: row.target_directory_handle,
    displayName: row.target_display_name,
  };
  const environment = parseEnvironment(row.environment_json);
  const environmentState = row.environment_lifecycle === 'prepared' || row.environment_lifecycle === 'applied' || row.environment_lifecycle === 'discarded'
    ? row.environment_lifecycle
    : environment?.applied === true
      ? 'applied'
    : undefined;
  return {
    id: row.id,
    documentId: row.document_id,
    profileId: row.profile_id,
    providerId: providerFromProfileId(row.provider_id),
    targetDirectory,
    executionMode: row.sandbox_mode,
    status: row.status,
    providerSessionId: row.provider_session_id,
    userPrompt: row.user_prompt,
    contextSummary: row.context_summary,
    effectiveModel: row.effective_model ?? null,
    effectiveReasoningEffort: row.effective_reasoning_effort ?? null,
    createdAt: normalizeSqliteTimestamp(row.created_at),
    updatedAt: normalizeSqliteTimestamp(row.updated_at),
    finalReport: row.final_report,
    environment,
    eventCount: row.event_count,
    ...(environmentState === undefined ? {} : { environmentState }),
  };
}

function parseEnvironment(value: string | null): AgentSessionEnvironment | null {
  if (value === null) return null;
  try {
    const parsed: PortableValue = parsePortableJson(value);
    if (typeof parsed !== 'object' || parsed === null || !('sessionId' in parsed) || typeof parsed.sessionId !== 'string') return null;
    const { sessionId, ...reviewPayload } = parsed;
    const review = agentEnvironmentReviewSchema.parse(reviewPayload);
    return { ...review, sessionId };
  } catch {
    return null;
  }
}
