import { testSessionAuthority, testTargetIdentity } from '../helpers/agent-session-records';
import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { eventError } from '../helpers/agent-event';

const profile: MainAgentProfile = {
  id: 'fake', providerId: 'fake', name: 'Fixture', binaryPath: 'fixture', defaultArgs: [],
  defaultModel: null, reasoningEffort: null, permissionMode: 'fixture', defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: false, nativeSandbox: true, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: 'fixture', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};

describe('AgentRepository persistence and replay bounds', () => {
  it('persists profiles, directories, sessions, artifacts, and only replays the latest bounded events', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const repository = new AgentRepository(database);
    repository.upsertProfile(profile);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-fixture', 'Doc Fixture', 'pdf', '/tmp/fixture.pdf', 'managed', 100, 100, 'hash-fixture')
    `).run();
    repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 1, inode: 2, birthtimeNs: '3' });
    const session = repository.createSession({
      documentId: 'doc-fixture',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy', userPrompt: 'test', baselineFingerprint: 'fingerprint', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });
    repository.addArtifact({ sessionId: session.id, kind: 'log', metadata: { source: 'test' } });
    repository.appendEvent({ sessionId: session.id, type: 'started', timestamp: new Date().toISOString() });
    for (let index = 0; index < 500; index += 1) repository.appendEvent({ sessionId: session.id, type: 'stdout', stream: 'stdout', text: String(index), timestamp: new Date().toISOString() });
    const replay = repository.listEvents(session.id);
    expect(replay).toHaveLength(500);
    expect(replay[0]?.ordinal).toBe(1);
    expect(replay.at(-1)?.ordinal).toBe(500);
    const detail = repository.getSessionDetail(session.id);
    expect(detail?.artifacts[0]?.metadata).toEqual({ source: 'test' });
    expect(detail?.targetDirectory).toEqual({ handle: 'dir-handle', displayName: 'agent-fixture' });
    expect('canonicalTargetPath' in (detail ?? {})).toBe(false);
    database.close();
  });

  it('recovers queued sessions as interrupted and rejects corrupt persisted events', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const repository = new AgentRepository(database);
    repository.upsertProfile(profile);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-fixture', 'Doc Fixture', 'pdf', '/tmp/fixture.pdf', 'managed', 100, 100, 'hash-fixture')
    `).run();
    repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 1, inode: 2, birthtimeNs: '3' });
    const session = repository.createSession({
      documentId: 'doc-fixture',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy', userPrompt: 'test', baselineFingerprint: 'fingerprint', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });
    const recovered = new AgentRepository(database).getSession(session.id);
    expect(recovered?.status).toBe('interrupted');
    database.raw.prepare('INSERT INTO agent_events (id, session_id, ordinal, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('bad', session.id, 0, 'stdout', '{"nope":true}', new Date().toISOString());
    expect(() => repository.listEvents(session.id)).toThrow(/stored agent event is invalid/i);
    database.close();
  });
  it('maps profile ids to providers without resolving inherited object keys', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const repository = new AgentRepository(database);
    // `constructor`, `toString` and `hasOwnProperty` are inherited from
    // `Object.prototype`: the id lookup must not hand them back as providers.
    for (const id of ['cursor', 'constructor', 'toString', 'hasOwnProperty', 'custom:fixture']) {
      repository.upsertProfile({ ...profile, id, providerId: 'custom', isCustom: id.startsWith('custom:') });
    }

    const providers = new Map(repository.listProfiles().map((listed) => [listed.id, listed.providerId]));
    expect(providers.get('cursor')).toBe('cursor');
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', 'custom:fixture']) {
      expect(providers.get(inherited)).toBe('custom');
    }
    database.close();
  });

  it('normalizes a pre-rebrand error event on read and still rejects lookalikes', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const repository = new AgentRepository(database);
    repository.upsertProfile(profile);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-fixture', 'Doc Fixture', 'pdf', '/tmp/fixture.pdf', 'managed', 100, 100, 'hash-fixture')
    `).run();
    repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 1, inode: 2, birthtimeNs: '3' });
    const session = repository.createSession({
      documentId: 'doc-fixture',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy', userPrompt: 'test', baselineFingerprint: 'fingerprint', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });
    const timestamp = new Date().toISOString();
    const insert = database.raw.prepare(
      'INSERT INTO agent_events (id, session_id, ordinal, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // Exactly what a session recorded before the Interleaf rename holds.
    insert.run('legacy-error', session.id, 0, 'error', JSON.stringify({
      sessionId: session.id, ordinal: 0, type: 'error', timestamp,
      error: { __marginlabError: true, code: 'agent-failed', message: 'Legacy failure', detail: 'kept' },
    }), timestamp);

    const detail = repository.getSessionDetail(session.id);

    expect(eventError(detail?.events[0])).toEqual({
      __interleafError: true,
      code: 'agent-failed',
      message: 'Legacy failure',
      detail: 'kept',
    });

    // A lookalike that breaks the bounded rules is not normalized; it stays
    // invalid and fails the read rather than becoming a trusted error value.
    insert.run('legacy-lookalike', session.id, 1, 'error', JSON.stringify({
      sessionId: session.id, ordinal: 1, type: 'error', timestamp,
      error: { __marginlabError: true, code: 'x'.repeat(200), message: '' },
    }), timestamp);
    expect(() => repository.listEvents(session.id)).toThrow(/stored agent event is invalid/i);
    database.close();
  });

  it('persists and round-trips effectiveModel and effectiveReasoningEffort snapshots', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const repository = new AgentRepository(database);
    repository.upsertProfile(profile);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-fixture', 'Doc Fixture', 'pdf', '/tmp/fixture.pdf', 'managed', 100, 100, 'hash-fixture')
    `).run();
    repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 1, inode: 2, birthtimeNs: '3' });

    // 1. Session with specific effectiveModel and reasoning effort
    const sessionWithConfig = repository.createSession({
      documentId: 'doc-fixture',
      profileId: profile.id,
      providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture',
      sandboxMode: 'isolated-copy',
      userPrompt: 'test prompt',
      effectiveModel: 'claude-3-7-sonnet',
      effectiveReasoningEffort: 'high',
      baselineFingerprint: 'fingerprint-1', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    expect(sessionWithConfig.effectiveModel).toBe('claude-3-7-sonnet');
    expect(sessionWithConfig.effectiveReasoningEffort).toBe('high');

    const loaded = repository.getSession(sessionWithConfig.id);
    expect(loaded?.effectiveModel).toBe('claude-3-7-sonnet');
    expect(loaded?.effectiveReasoningEffort).toBe('high');

    const loadedDetail = repository.getSessionDetail(sessionWithConfig.id);
    expect(loadedDetail?.effectiveModel).toBe('claude-3-7-sonnet');
    expect(loadedDetail?.effectiveReasoningEffort).toBe('high');

    // 2. Session with null effectiveModel and null reasoning effort (e.g. default without selection)
    const sessionNullConfig = repository.createSession({
      documentId: 'doc-fixture',
      profileId: profile.id,
      providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture',
      sandboxMode: 'isolated-copy',
      userPrompt: 'test prompt 2',
      effectiveModel: null,
      effectiveReasoningEffort: null,
      baselineFingerprint: 'fingerprint-2', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    expect(sessionNullConfig.effectiveModel).toBeNull();
    expect(sessionNullConfig.effectiveReasoningEffort).toBeNull();

    const loadedNull = repository.getSession(sessionNullConfig.id);
    expect(loadedNull?.effectiveModel).toBeNull();
    expect(loadedNull?.effectiveReasoningEffort).toBeNull();

    // 3. Listed sessions retain effective configurations
    const sessions = repository.listSessions('doc-fixture');
    expect(sessions.find((s) => s.id === sessionWithConfig.id)?.effectiveModel).toBe('claude-3-7-sonnet');
    expect(sessions.find((s) => s.id === sessionNullConfig.id)?.effectiveModel).toBeNull();

    database.close();
  });

  it('binds sessions to documents, filters by documentId, excludes legacy unbound sessions, and handles cascading deletes', () => {
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);

    // Verify migration 19 added the index
    const indexes = database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_sessions_document_id'").all();
    expect(indexes).toHaveLength(1);

    // Insert documents
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-a', 'Doc A', 'pdf', '/tmp/a.pdf', 'managed', 100, 100, 'hash-a'),
             ('doc-b', 'Doc B', 'pdf', '/tmp/b.pdf', 'managed', 200, 200, 'hash-b')
    `).run();

    const repository = new AgentRepository(database);
    repository.upsertProfile(profile);
    repository.registerWorkingDirectory({ handle: 'dir-handle', canonicalPath: '/tmp/agent-fixture', displayName: 'agent-fixture', device: 1, inode: 2, birthtimeNs: '3' });

    // 1. Create sessions bound to doc-a, doc-b, and legacy unbound (null)
    const sessionDocA1 = repository.createSession({
      documentId: 'doc-a',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy',
      userPrompt: 'doc a session 1', baselineFingerprint: 'fp-a1', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    const sessionDocA2 = repository.createSession({
      documentId: 'doc-a',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy',
      userPrompt: 'doc a session 2', baselineFingerprint: 'fp-a2', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    const sessionDocB = repository.createSession({
      documentId: 'doc-b',
      profileId: profile.id, providerId: profile.providerId,
      targetDirectory: { handle: 'dir-handle', displayName: 'agent-fixture' },
      canonicalTargetPath: '/tmp/agent-fixture', sandboxMode: 'isolated-copy',
      userPrompt: 'doc b session', baselineFingerprint: 'fp-b', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    database.raw.prepare(`
      INSERT INTO agent_sessions (id, document_id, profile_id, target_directory_handle, canonical_target_path, sandbox_mode, status, user_prompt, baseline_fingerprint)
      VALUES ('legacy-unbound', NULL, ?, 'dir-handle', '/tmp/agent-fixture', 'isolated-copy', 'queued', 'legacy unbound session', 'fp-legacy')
    `).run(profile.id);
    // Verify getSession returns documentId and rejects legacy unbound rows.
    expect(repository.getSession(sessionDocA1.id)?.documentId).toBe('doc-a');
    expect(repository.getSession(sessionDocB.id)?.documentId).toBe('doc-b');
    expect(repository.getSession('legacy-unbound')).toBeNull();
    expect(repository.getSessionDetailForDocument(sessionDocA1.id, 'doc-a')?.documentId).toBe('doc-a');
    expect(repository.getSessionDetailForDocument(sessionDocA1.id, 'doc-b')).toBeNull();
    expect(repository.getSessionDetailForDocument('legacy-unbound', 'doc-a')).toBeNull();

    // 2. listSessions('doc-a') returns only doc-a sessions
    const docASessions = repository.listSessions('doc-a');
    expect(docASessions).toHaveLength(2);
    expect(docASessions.map((s) => s.id).sort()).toEqual([sessionDocA1.id, sessionDocA2.id].sort());
    expect(docASessions.every((s) => s.documentId === 'doc-a')).toBe(true);

    // 3. listSessions('doc-b') returns only doc-b session
    const docBSessions = repository.listSessions('doc-b');
    expect(docBSessions).toHaveLength(1);
    expect(docBSessions[0]?.id).toBe(sessionDocB.id);
    expect(docBSessions[0]?.documentId).toBe('doc-b');

    // 4. listSessions('doc-c') for document with no sessions returns empty array
    expect(repository.listSessions('doc-c')).toHaveLength(0);

    // 5. Legacy unbound sessions are excluded when querying by documentId
    expect(docASessions.some((s) => s.id === 'legacy-unbound')).toBe(false);
    expect(docBSessions.some((s) => s.id === 'legacy-unbound')).toBe(false);

    // 6. Parameterized SQL prevents injection attempts
    const injectionAttempt = "' OR '1'='1";
    expect(repository.listSessions(injectionAttempt)).toHaveLength(0);

    // 7. Foreign key cascade deletion: deleting doc-a removes doc-a sessions
    database.raw.prepare("DELETE FROM documents WHERE id = 'doc-a'").run();
    expect(repository.listSessions('doc-a')).toHaveLength(0);
    expect(repository.getSession(sessionDocA1.id)).toBeNull();
    expect(repository.getSession(sessionDocA2.id)).toBeNull();
    // doc-b is untouched; legacy unbound rows remain inaccessible.
    expect(repository.getSession(sessionDocB.id)).not.toBeNull();
    expect(repository.getSession('legacy-unbound')).toBeNull();

    database.close();
  });
});
