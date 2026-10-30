import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import { normalizeSqliteTimestamp } from '../sqlite-timestamp';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  customAgentProfileConfigSchema,
  executableIdentitySchema,
  type CustomAgentProfileConfig,
  type ExecutableIdentity,
} from '@shared/schemas/custom-agent-profile';
import type { CustomAgentProfile } from '@shared/types/custom-agent-profile';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';

export type StoredCustomAgentProfile = {
  readonly id: string;
  readonly name: string;
  readonly canonicalPath: string;
  readonly identity: ExecutableIdentity;
  readonly config: CustomAgentProfileConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ProfileRow = {
  id: string;
  name: string;
  binary_path: string;
  custom_config_json: string | null;
  executable_identity_json: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const CUSTOM_ID_PATTERN = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Main-owned, versioned custom-profile storage. The additive columns are
 * installed by the normal checksum-protected database migration; the JSON
 * carries config `version: 1` so future profile changes can migrate without
 * exposing paths to renderer code. All SQL values remain parameterized.
 */
export class CustomAgentProfileRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
  }

  list(): readonly StoredCustomAgentProfile[] {
    const rows = this.db.prepare(`
      SELECT id, name, binary_path, custom_config_json, executable_identity_json, created_at, updated_at
        , deleted_at FROM agent_profiles WHERE is_custom = 1 AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all() as ProfileRow[];
    return rows.map((row) => this.parseRow(row));
  }

  get(id: string): StoredCustomAgentProfile | null {
    const row = this.db.prepare(`
      SELECT id, name, binary_path, custom_config_json, executable_identity_json, created_at, updated_at
        , deleted_at FROM agent_profiles WHERE id = ? AND is_custom = 1 AND deleted_at IS NULL
    `).get(id) as ProfileRow | undefined;
    return row === undefined ? null : this.parseRow(row);
  }

  create(input: {
    readonly id: string;
    readonly name: string;
    readonly canonicalPath: string;
    readonly identity: ExecutableIdentity;
    readonly config: CustomAgentProfileConfig;
  }): StoredCustomAgentProfile {
    assertCustomId(input.id);
    const config = customAgentProfileConfigSchema.parse(input.config);
    const identity = executableIdentitySchema.parse(input.identity);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_profiles (
        id, name, binary_path, default_args_json, default_model, reasoning_effort,
        permission_mode, default_sandbox_mode, env_reference_json, is_custom,
        custom_config_json, executable_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, NULL, 1, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.canonicalPath,
      JSON.stringify(config.executionKind === 'expert-shell' ? [] : config.argvTemplate),
      config.defaultModel ?? null,
      config.reasoningEffort ?? null,
      config.defaultSandboxMode,
      JSON.stringify(config),
      JSON.stringify(identity),
      now,
      now,
    );
    const created = this.get(input.id);
    if (created === null) throw new InterleafError('internal', 'Custom agent profile could not be loaded after creation.');
    return created;
  }

  update(id: string, update: {
    readonly name: string;
    readonly canonicalPath: string;
    readonly identity: ExecutableIdentity;
    readonly config: CustomAgentProfileConfig;
  }): StoredCustomAgentProfile {
    const existing = this.get(id);
    if (existing === null) throw new InterleafError('validation', 'The custom agent profile does not exist.');
    const config = customAgentProfileConfigSchema.parse(update.config);
    const identity = executableIdentitySchema.parse(update.identity);
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE agent_profiles SET name = ?, binary_path = ?, default_args_json = ?,
        default_model = ?, reasoning_effort = ?,
        default_sandbox_mode = ?, custom_config_json = ?, executable_identity_json = ?,
        updated_at = ?
      WHERE id = ? AND is_custom = 1
    `).run(
      update.name,
      update.canonicalPath,
      JSON.stringify(config.executionKind === 'expert-shell' ? [] : config.argvTemplate),
      config.defaultModel ?? null,
      config.reasoningEffort ?? null,
      config.defaultSandboxMode,
      JSON.stringify(config),
      JSON.stringify(identity),
      updatedAt,
      id,
    );
    const result = this.get(id);
    if (result === null) throw new InterleafError('internal', 'Updated custom agent profile could not be loaded.');
    return result;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (existing === null) throw new InterleafError('validation', 'Built-in or unknown agent profiles cannot be deleted.');
    // Keep the profile row as a historical snapshot for agent_sessions. A
    // soft delete removes it from active CRUD/selection while preserving
    // foreign-key history and the profile name/config used by old sessions.
    this.db.prepare('UPDATE agent_profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND is_custom = 1 AND deleted_at IS NULL')
      .run(new Date().toISOString(), new Date().toISOString(), id);
  }

  toPublic(record: StoredCustomAgentProfile, executable: { readonly handle: string; readonly displayName: string; readonly fingerprint: string } | null): CustomAgentProfile {
    const config = record.config;
    if (config.executionKind === 'expert-shell') {
      return {
        id: record.id,
        name: record.name,
        executable,
        executionKind: 'expert-shell',
        shellFamily: config.shellFamily,
        shellCommand: config.shellCommand,
        resumeShellCommand: config.resumeShellCommand ?? null,
        promptDeliveryMode: 'stdin',
        stdoutParsingMode: config.stdoutParsingMode,
        defaultModel: config.defaultModel ?? null,
        reasoningEffort: config.reasoningEffort ?? null,
        supportsModelSelection: config.supportsModelSelection,
        supportsReasoningSelection: config.supportsReasoningSelection,
        supportsResume: config.supportsResume,
        workingDirectoryPolicy: config.workingDirectoryPolicy,
        defaultSandboxMode: config.defaultSandboxMode,
        environmentOverrides: config.environmentOverrides,
        unsafe: config.unsafe,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    return {
      id: record.id,
      name: record.name,
      executable,
      executionKind: 'normal',
      argvTemplate: config.argvTemplate,
      promptDeliveryMode: config.promptDeliveryMode,
      stdoutParsingMode: config.stdoutParsingMode,
      defaultModel: config.defaultModel ?? null,
      reasoningEffort: config.reasoningEffort ?? null,
      supportsModelSelection: config.supportsModelSelection,
      supportsReasoningSelection: config.supportsReasoningSelection,
      resumeCommandTemplate: config.resumeCommandTemplate ?? null,
      supportsResume: config.supportsResume,
      workingDirectoryPolicy: config.workingDirectoryPolicy,
      defaultSandboxMode: config.defaultSandboxMode,
      environmentOverrides: config.environmentOverrides,
      unsafe: config.unsafe,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private parseRow(row: ProfileRow): StoredCustomAgentProfile {
    if (!CUSTOM_ID_PATTERN.test(row.id) || row.custom_config_json === null || row.executable_identity_json === null) {
      throw new InterleafError('internal', 'Stored custom agent profile is malformed.');
    }
    const { config, identity } = parseStoredProfile(row.custom_config_json, row.executable_identity_json);
    return {
      id: row.id,
      name: row.name,
      canonicalPath: row.binary_path,
      identity,
      config,
      createdAt: normalizeSqliteTimestamp(row.created_at),
      updatedAt: normalizeSqliteTimestamp(row.updated_at),
    };
  }
}

/** The two stored JSON columns, decoded and validated against their schemas. */
function parseStoredProfile(
  configJson: string,
  identityJson: string,
): Pick<StoredCustomAgentProfile, 'config' | 'identity'> {
  const configValue = decodeStoredJson(configJson);
  const identityValue = decodeStoredJson(identityJson);
  try {
    return {
      config: customAgentProfileConfigSchema.parse(configValue),
      identity: executableIdentitySchema.parse(identityValue),
    };
  } catch (error) {
    throw new InterleafError('internal', 'Stored custom agent profile config is malformed.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

/** One stored JSON column, as a structured value. */
function decodeStoredJson(json: string): PortableValue {
  try {
    return parsePortableJson(json);
  } catch (error) {
    throw new InterleafError('internal', 'Stored custom agent profile data is not valid JSON.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

function assertCustomId(id: string): void {
  if (!CUSTOM_ID_PATTERN.test(id)) throw new InterleafError('validation', 'Custom profile IDs are generated by Interleaf and are immutable.');
}
