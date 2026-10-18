import { describe, expect, it, vi } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  cleanupBootstrapResources,
  formatFatalBootstrapDiagnostic,
  type BootstrapResources,
} from '@main/app/bootstrap-diagnostics';

describe('formatFatalBootstrapDiagnostic', () => {
  it('formats InterleafError with code, category, and redacted message without stack or cause', () => {
    const cause = new Error('Underlying database constraint failure');
    const error = new InterleafError(
      'internal',
      'Schema migration drift detected for version 2 (seed_default_settings).',
      { cause }
    );

    const diagnostic = formatFatalBootstrapDiagnostic(error);

    expect(diagnostic).toEqual({
      errorType: 'InterleafError',
      code: 'internal',
      category: 'internal',
      message: 'Schema migration drift detected for version 2 (seed_default_settings).',
    });

    // Invariant: no stack, cause, raw SQL, or env properties on the diagnostic
    expect(diagnostic).not.toHaveProperty('stack');
    expect(diagnostic).not.toHaveProperty('cause');
    expect(diagnostic).not.toHaveProperty('sql');
  });

  it('redacts tokens, API keys, JWTs, and home paths from error messages', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value';
    const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
    const message = `Failed to open /Users/alice/data/db.sqlite with apiKey="sk-secret-12345" and ${jwt} and ${privateKey}`;
    const error = new InterleafError('security-violation', message);

    const diagnostic = formatFatalBootstrapDiagnostic(error);

    expect(diagnostic.errorType).toBe('InterleafError');
    expect(diagnostic.code).toBe('security-violation');
    expect(diagnostic.category).toBe('security-violation');
    expect(diagnostic.message).not.toContain('/Users/alice');
    expect(diagnostic.message).toContain('/[user-home]/data/db.sqlite');
    expect(diagnostic.message).not.toContain('sk-secret-12345');
    expect(diagnostic.message).not.toContain(jwt);
    expect(diagnostic.message).not.toContain('secret-material');
    expect(diagnostic.message).toContain('[redacted]');
  });

  it('formats generic Error with internal code and redacted message', () => {
    const error = new TypeError('Cannot read properties of undefined (reading /Users/alice/data)');
    const diagnostic = formatFatalBootstrapDiagnostic(error);

    expect(diagnostic).toEqual({
      errorType: 'TypeError',
      code: 'internal',
      category: 'internal',
      message: expect.stringContaining('/[user-home]/data'),
    });
    expect(diagnostic).not.toHaveProperty('stack');
  });

  it('formats a value that was not an error as one fixed safe diagnostic', () => {
    // A catch block passes `null` for anything it could not narrow to an error,
    // so a thrown string never reaches a diagnostic as its own description.
    expect(formatFatalBootstrapDiagnostic(null)).toEqual({
      errorType: 'unknown',
      code: 'internal',
      category: 'internal',
      message: 'An unknown fatal error occurred during startup.',
    });
  });
});

describe('cleanupBootstrapResources', () => {
  it('cleans up all provided resources and flushes logs in order', async () => {
    const closeDb = vi.fn();
    const clearRegistry = vi.fn();
    const shutdownChat = vi.fn().mockResolvedValue(undefined);
    const shutdownAgent = vi.fn().mockResolvedValue(undefined);
    const flushLogs = vi.fn().mockResolvedValue(undefined);
    const resetLogs = vi.fn();

    const timer1 = setInterval(() => undefined, 100_000);
    const timer2 = setInterval(() => undefined, 100_000);

    const resources: BootstrapResources = {
      database: { close: closeDb },
      assetRegistry: { clear: clearRegistry },
      assetSweepTimer: timer1,
      managedOrphanSweepTimer: timer2,
      chatService: { shutdown: shutdownChat },
      agentService: { shutdown: shutdownAgent },
      flushLogs,
      resetLogs,
    };

    await cleanupBootstrapResources(resources);

    expect(clearRegistry).toHaveBeenCalledTimes(1);
    expect(shutdownChat).toHaveBeenCalledTimes(1);
    expect(shutdownAgent).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(resetLogs).toHaveBeenCalledTimes(1);
  });

  it('safely tolerates and absorbs failures during resource shutdown and log flush', async () => {
    const closeDb = vi.fn().mockImplementation(() => {
      throw new Error('Database close error');
    });
    const clearRegistry = vi.fn().mockImplementation(() => {
      throw new Error('Asset registry error');
    });
    const shutdownChat = vi.fn().mockRejectedValue(new Error('Chat shutdown error'));
    const shutdownAgent = vi.fn().mockRejectedValue(new Error('Agent shutdown error'));
    const flushLogs = vi.fn().mockRejectedValue(new Error('Flush disk write error'));
    const resetLogs = vi.fn().mockImplementation(() => {
      throw new Error('Reset log error');
    });

    const resources: BootstrapResources = {
      database: { close: closeDb },
      assetRegistry: { clear: clearRegistry },
      chatService: { shutdown: shutdownChat },
      agentService: { shutdown: shutdownAgent },
      flushLogs,
      resetLogs,
    };

    // Must not throw even if every single cleanup step throws or rejects
    await expect(cleanupBootstrapResources(resources)).resolves.toBeUndefined();

    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(clearRegistry).toHaveBeenCalledTimes(1);
    expect(shutdownChat).toHaveBeenCalledTimes(1);
    expect(shutdownAgent).toHaveBeenCalledTimes(1);
    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(resetLogs).toHaveBeenCalledTimes(1);
  });
});
