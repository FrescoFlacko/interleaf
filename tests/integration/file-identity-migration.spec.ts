import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, MIGRATIONS, runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { assertPersistedTargetUnchanged } from '@main/agents/session-authority';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { parsePortableJson, type PortableValue } from '@shared/models/portable';
import { testSessionAuthority } from '../helpers/agent-session-records';

/**
 * Migration 26 adds birth time to every persisted file identity. There is no
 * honest value to backfill, so legacy identities gain an explicit
 * `birthtimeNs: null`: the rows stay readable, but nothing they describe can
 * be proven, so every privileged continuation fails closed until the folder or
 * executable is selected again.
 */

const BIRTH_TIME_VERSION = 26;
const LEGACY_PROFILE_ID = 'custom:0e3c6f1a-8d2b-4c5e-9f7a-1b2c3d4e5f60';

const LEGACY_CONFIG = JSON.stringify({
  version: 1, executionKind: 'normal', argvTemplate: [], promptDeliveryMode: 'stdin', stdoutParsingMode: 'text',
  defaultModel: null, reasoningEffort: null, supportsModelSelection: false, supportsReasoningSelection: false,
  resumeCommandTemplate: null, supportsResume: false, workingDirectoryPolicy: 'select-per-run',
  defaultSandboxMode: 'auto-isolated', environmentOverrides: [], unsafe: false,
});

function identityColumn(database: InterleafDatabase, sql: string): PortableValue | undefined {
  const row = database.raw.prepare(sql).get() as { readonly value: string } | undefined;
  return row === undefined ? undefined : parsePortableJson(row.value);
}

describe('file identity birth-time migration', () => {
  it('is migration 26, in place and named', () => {
    expect(MIGRATIONS[BIRTH_TIME_VERSION - 1]).toMatchObject({ version: BIRTH_TIME_VERSION, name: 'file_identity_birth_time' });
  });

  it('keeps legacy identities readable but unprovable, so continuations fail closed', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-identity-migration-')));
    const database = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(database, MIGRATIONS.slice(0, BIRTH_TIME_VERSION - 1));
      // The real directory's device and inode, exactly as a pre-26 build recorded them.
      const legacy = await stat(root);
      const legacyIdentity = { device: legacy.dev, inode: legacy.ino };
      database.raw.prepare(`
        INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, default_sandbox_mode)
        VALUES ('fake', 'Fixture', 'fixture', '[]', 'fixture', 'isolated-copy')
      `).run();
      database.raw.prepare(`
        INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, is_custom, custom_config_json, executable_identity_json)
        VALUES (?, 'Legacy custom', '/usr/local/bin/agent', '[]', 'custom', 1, ?, ?)
      `).run(LEGACY_PROFILE_ID, LEGACY_CONFIG, JSON.stringify({ device: 1, inode: 2, size: 3, mtimeMs: 4, sha256: 'a'.repeat(64) }));
      database.raw.prepare(`
        INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('doc-identity', 'Doc', 'pdf', '/tmp/identity.pdf', 'managed', 10, 10, 'hash-identity')
      `).run();
      database.raw.prepare(`
        INSERT INTO allowed_working_directories (handle, canonical_path, display_name, identity_json)
        VALUES ('dir-handle', ?, 'workspace', ?), ('dir-malformed', '/tmp/malformed', 'malformed', 'not json')
      `).run(root, JSON.stringify(legacyIdentity));
      database.raw.prepare(`
        INSERT INTO agent_sessions (id, document_id, profile_id, target_directory_handle, canonical_target_path, sandbox_mode, user_prompt, status, baseline_fingerprint, target_identity_json, authority_json)
        VALUES ('session-legacy', 'doc-identity', 'fake', 'dir-handle', ?, 'isolated-copy', 'legacy prompt', 'completed', 'fp', ?, ?)
      `).run(
        root,
        JSON.stringify({ version: 1, directoryHandle: 'dir-handle', canonicalPath: root, ...legacyIdentity }),
        JSON.stringify(testSessionAuthority({ profileId: 'fake' })),
      );

      expect(runMigrations(database)).toBe(MIGRATIONS.length - (BIRTH_TIME_VERSION - 1));

      // Every legacy identity now states explicitly that its birth time is unknown.
      expect(identityColumn(database, `SELECT identity_json AS value FROM allowed_working_directories WHERE handle = 'dir-handle'`))
        .toEqual({ ...legacyIdentity, birthtimeNs: null });
      expect(identityColumn(database, `SELECT target_identity_json AS value FROM agent_sessions WHERE id = 'session-legacy'`))
        .toEqual({ version: 1, directoryHandle: 'dir-handle', canonicalPath: root, ...legacyIdentity, birthtimeNs: null });
      expect(identityColumn(database, `SELECT executable_identity_json AS value FROM agent_profiles WHERE id = '${LEGACY_PROFILE_ID}'`))
        .toMatchObject({ device: 1, inode: 2, birthtimeNs: null });
      // A value that is not a JSON object is left for the reader to reject.
      expect(database.raw.prepare(`SELECT identity_json AS value FROM allowed_working_directories WHERE handle = 'dir-malformed'`).get())
        .toEqual({ value: 'not json' });

      // Still readable: the capability row, the session, and the profile.
      const repository = new AgentRepository(database);
      expect(repository.getWorkingDirectory('dir-handle')).toMatchObject({ canonicalPath: root, ...legacyIdentity, birthtimeNs: null });
      expect(repository.getSession('session-legacy')?.userPrompt).toBe('legacy prompt');
      const targetIdentity = repository.getSessionAuthority('session-legacy')?.targetIdentity ?? null;
      expect(targetIdentity).toMatchObject({ ...legacyIdentity, birthtimeNs: null });
      expect(new CustomAgentProfileRepository(database).get(LEGACY_PROFILE_ID)?.identity.birthtimeNs).toBeNull();

      // But unprovable: the very same directory, untouched, cannot be continued.
      if (targetIdentity === null) throw new Error('legacy target identity was not readable');
      await expect(assertPersistedTargetUnchanged(targetIdentity)).rejects.toThrow(/was replaced; this session cannot continue/u);
      const registry = new WorkingDirectoryRegistry();
      registry.useDurableSource((handle) => repository.getWorkingDirectory(handle));
      await expect(registry.resolve('dir-handle')).rejects.toMatchObject({
        code: 'mode-resolution-failed',
        message: 'The registered working directory changed and must be selected again.',
      });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
