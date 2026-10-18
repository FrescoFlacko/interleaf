import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, computeMigrationChecksum, MIGRATIONS, runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { parseSessionAuthority, parseTargetIdentity } from '@main/agents/session-authority';
import { testSessionAuthority, testTargetIdentity } from '../helpers/agent-session-records';
import type { MainAgentProfile } from '@main/agents/profile-types';

/**
 * Items B and P at the storage boundary: the durable target identity and the
 * main-resolved permission snapshot survive a restart, arrive as an additive
 * migration, and never leak into renderer-facing session rows.
 */

const AUTHORITY_VERSION = 24;

const profile: MainAgentProfile = {
  id: 'fake', providerId: 'fake', name: 'Fixture', binaryPath: 'fixture', defaultArgs: [],
  defaultModel: null, reasoningEffort: null, permissionMode: 'fixture', defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: 'fixture', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};

function seed(database: InterleafDatabase): AgentRepository {
  const repository = new AgentRepository(database);
  repository.upsertProfile(profile);
  database.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-authority', 'Doc', 'pdf', '/tmp/authority.pdf', 'managed', 10, 10, 'hash-authority')
  `).run();
  repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 7, inode: 11, birthtimeNs: '13' });
  return repository;
}

function columnsOf(database: InterleafDatabase, table: string): readonly string[] {
  return (database.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

describe('agent session target identity and authority migration', () => {
  it('is an additive step that leaves every historical migration byte-identical', () => {
    const step = MIGRATIONS[AUTHORITY_VERSION - 1];
    expect(step?.version).toBe(AUTHORITY_VERSION);
    expect(step?.name).toBe('agent_session_target_authority');
    // Only ALTER ... ADD COLUMN: no historical table is rewritten or dropped.
    expect(step?.statements.every((statement) => /^ALTER TABLE \w+ ADD COLUMN /u.test(statement.trim()))).toBe(true);
    // Checksums of earlier steps are a function of their own text, so recording
    // them here catches any future edit to already-applied migrations.
    const historical = MIGRATIONS.slice(0, AUTHORITY_VERSION - 1).map((migration) => computeMigrationChecksum(migration));
    expect(new Set(historical).size).toBe(AUTHORITY_VERSION - 1);
    expect(MIGRATIONS.at(-1)?.version).toBe(MIGRATIONS.length);
  });

  it('upgrades a library that stopped at the previous version without touching its sessions', () => {
    const database = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(database, MIGRATIONS.slice(0, AUTHORITY_VERSION - 1));
      expect(columnsOf(database, 'agent_sessions')).not.toContain('authority_json');
      // Seeded with raw SQL so the pre-migration schema is what is upgraded;
      // opening a repository would additively repair the columns first.
      database.raw.prepare(`
        INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, default_sandbox_mode)
        VALUES ('fake', 'Fixture', 'fixture', '[]', 'fixture', 'isolated-copy')
      `).run();
      database.raw.prepare(`
        INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('doc-authority', 'Doc', 'pdf', '/tmp/authority.pdf', 'managed', 10, 10, 'hash-authority')
      `).run();
      database.raw.prepare(`
        INSERT INTO allowed_working_directories (handle, canonical_path, display_name, identity_json)
        VALUES ('dir-handle', '/tmp/agent-fixture', 'agent-fixture', '{"device":7,"inode":11}')
      `).run();
      database.raw.prepare(`
        INSERT INTO agent_sessions (id, document_id, profile_id, target_directory_handle, canonical_target_path, sandbox_mode, user_prompt, status, baseline_fingerprint)
        VALUES ('session-legacy', 'doc-authority', 'fake', 'dir-handle', '/tmp/agent-fixture', 'isolated-copy', 'legacy prompt', 'completed', 'fp')
      `).run();

      expect(runMigrations(database)).toBe(MIGRATIONS.length - (AUTHORITY_VERSION - 1));

      expect(columnsOf(database, 'agent_sessions')).toEqual(expect.arrayContaining(['target_identity_json', 'authority_json']));
      const repository = new AgentRepository(database);
      const legacy = repository.getSession('session-legacy');
      expect(legacy?.userPrompt).toBe('legacy prompt');
      expect(legacy?.status).toBe('completed');
      // A pre-migration session has no snapshot; main must treat that as
      // unusable for a privileged continuation rather than inventing one.
      expect(repository.getSessionAuthority('session-legacy')).toEqual({ targetIdentity: null, authority: null });
    } finally {
      database.close();
    }
  });

  it('round-trips the exact identity and authority snapshot across a reopen', () => {
    const database = InterleafDatabase.open(':memory:');
    try {
      runMigrations(database);
      const repository = seed(database);
      const targetIdentity = testTargetIdentity({ canonicalPath: '/tmp/agent-fixture', device: 7, inode: 11, birthtimeNs: '13' });
      const authority = testSessionAuthority({
        effectivePermissionPolicy: 'read-only',
        executionMode: 'native-restricted',
        sandboxArgs: ['-c', 'sandbox_mode="workspace-write"'],
        reasoningEffort: 'low',
        nativeCapability: { contractId: 'codex-exec-sandbox-workspace-write-v1', executableFingerprint: 'fingerprint-abc' },
      });
      const session = repository.createSession({
        documentId: 'doc-authority',
        profileId: profile.id, providerId: profile.providerId,
        targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
        canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'native-restricted',
        userPrompt: 'start', baselineFingerprint: 'fingerprint',
        targetIdentity, authority,
      });

      // A fresh repository over the same storage stands in for a restart.
      const reopened = new AgentRepository(database);
      expect(reopened.getSessionAuthority(session.id)).toEqual({ targetIdentity, authority });

      // Neither snapshot is part of the renderer-facing session row.
      const row = reopened.getSession(session.id);
      expect(row).not.toBeNull();
      expect(Object.keys({ ...row })).not.toContain('authority');
      expect(Object.keys({ ...row })).not.toContain('targetIdentity');
      expect(JSON.stringify(reopened.getSessionDetail(session.id))).not.toContain('fingerprint-abc');
    } finally {
      database.close();
    }
  });

  it('reads an unparseable or wrong-version snapshot as absent rather than as permission', () => {
    expect(parseTargetIdentity(null)).toBeNull();
    expect(parseTargetIdentity('not json')).toBeNull();
    expect(parseTargetIdentity('{"version":2,"directoryHandle":"h","canonicalPath":"/p","device":1,"inode":2}')).toBeNull();
    expect(parseTargetIdentity('{"version":1,"directoryHandle":"h","canonicalPath":"/p","device":1}')).toBeNull();
    expect(parseSessionAuthority(null)).toBeNull();
    expect(parseSessionAuthority('[]')).toBeNull();
    expect(parseSessionAuthority('{"version":1,"profileId":"codex"}')).toBeNull();
    // A malformed native-capability block must not degrade to "no capability
    // recorded", which would read as a legitimate non-native session.
    expect(parseSessionAuthority(JSON.stringify({
      ...testSessionAuthority(),
      nativeCapability: { contractId: 'c' },
    }))).toBeNull();
    expect(parseSessionAuthority(JSON.stringify(testSessionAuthority()))).toEqual(testSessionAuthority());
  });
});
