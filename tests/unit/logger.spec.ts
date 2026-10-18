import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePortableJson } from '@shared/models/portable';
import {
  configureDurableLogging,
  createLogger,
  DurableLogSink,
  LOG_LIMITS,
  redactSecrets,
  redactString,
  resetDurableLogging,
  setDurableDebugLogging,
} from '@main/logging/logger';
import { createDebugLogExporter } from '@main/logging/debug-log-export';
import type { PortableRecord } from '@shared/models/portable';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetDurableLogging();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-logs-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('durable structured logging', () => {
  it('redacts quoted values with spaces and credential/token shapes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value';
    const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
    const output = redactString(`api-key="quoted value with spaces" password="foo\\"escaped-secret-suffix" visible-tail Bearer bearer-secret-value ${jwt} AKIAIOSFODNN7EXAMPLE ${privateKey}`);
    expect(output).not.toContain('quoted value with spaces');
    expect(output).not.toContain('escaped-secret-suffix');
    expect(output).toContain('visible-tail');
    expect(output).not.toContain('bearer-secret-value');
    expect(output).not.toContain(jwt);
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output).not.toContain('secret-material');
    expect(output).toContain('[redacted]');
  });

  it('redacts secret metadata, confidential bodies, home paths, and bounds nested values', () => {
    const source: PortableRecord = {
      apiKey: 'should-not-appear',
      bearerToken: 'bearer-secret',
      auth: 'auth-secret',
      authentication: 'authentication-secret',
      authorization: 'authorization-secret',
      documentBody: 'confidential document body',
      prompt: 'private prompt',
      stdout: 'raw agent stdout',
      path: '/Users/alice/private/project/file.txt',
      values: Array.from({ length: LOG_LIMITS.maxArrayLength + 20 }, (_, index) => `value-${String(index)}`),
      nested: { level1: { level2: { level3: { level4: { level5: { level6: 'too deep' } } } } } },
    };
    const redacted = redactSecrets(source);
    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.bearerToken).toBe('[redacted]');
    expect(redacted.auth).toBe('[redacted]');
    expect(redacted.authentication).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.documentBody).toBe('[redacted]');
    expect(redacted.prompt).toBe('[redacted]');
    expect(redacted.stdout).toBe('[redacted]');
    expect(redacted.path).toBe('/[user-home]/private/project/file.txt');
    expect(redacted.values).toHaveLength(LOG_LIMITS.maxArrayLength);
    expect(JSON.stringify(redacted)).not.toContain('too deep');
  });

  it('writes owner-only JSONL records and leaves debug disabled by default', async () => {
    const directory = makeDirectory();
    const sink = configureDurableLogging({ directory });
    const log = createLogger('security');
    log.debug('debug record');
    log.info('safe record', { operation: 'startup', token: 'never-written' });
    await sink.flush();

    const logPath = join(directory, 'interleaf.log');
    const text = await readFile(logPath, 'utf8');
    expect(text).not.toContain('debug record');
    expect(text).not.toContain('never-written');
    expect(parsePortableJson(text)).toMatchObject({ category: 'security', level: 'info' });
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('follows the diagnostic-logging preference while the application runs', async () => {
    const directory = makeDirectory();
    const sink = configureDurableLogging({ directory });
    const log = createLogger('app');

    log.debug('before-preference');
    setDurableDebugLogging(true);
    log.debug('after-enabling');
    setDurableDebugLogging(false);
    log.debug('after-disabling');
    log.info('always-kept');
    await sink.flush();

    const text = await readFile(join(directory, 'interleaf.log'), 'utf8');
    expect(text).not.toContain('before-preference');
    expect(text).toContain('after-enabling');
    expect(text).not.toContain('after-disabling');
    expect(text).toContain('always-kept');
    // Only the level filter moves; the sink keeps its own destination.
    expect(sink.currentPath).toBe(join(directory, 'interleaf.log'));
  });

  it('keeps debug records redacted when the preference turns them on', async () => {
    const directory = makeDirectory();
    const sink = configureDurableLogging({ directory, debugEnabled: true });
    createLogger('app').debug('diagnostic record', { apiKey: 'sk-or-v1-never-written' });
    await sink.flush();

    const text = await readFile(join(directory, 'interleaf.log'), 'utf8');
    expect(text).toContain('diagnostic record');
    expect(text).not.toContain('sk-or-v1-never-written');
    expect(text).toContain('[redacted]');
  });

  it('rotates with bounded retention and serializes concurrent writes', async () => {
    const directory = makeDirectory();
    const sink = configureDurableLogging({ directory, maxCurrentBytes: 260, retainedRotatedFiles: 3 });
    const log = createLogger('app');
    for (let index = 0; index < 30; index += 1) log.info(`record-${String(index)}`, { index });
    await sink.flush();
    const files = (await readdir(directory)).filter((name) => name.startsWith('interleaf.log'));
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files).toContain('interleaf.log');
    for (const file of files) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
  });

  it('refuses symlink log files and exports only bounded sanitized records', async () => {
    const directory = makeDirectory();
    const outside = join(directory, '..', 'interleaf-log-outside.txt');
    writeFileSync(outside, 'outside-preserved');
    symlinkSync(outside, join(directory, 'interleaf.log'));
    const sink = new DurableLogSink({ directory });
    sink.append(JSON.stringify({ timestamp: new Date().toISOString(), category: 'security', level: 'info', message: 'attempt' }));
    await sink.flush();
    expect(readFileSync(outside, 'utf8')).toBe('outside-preserved');
    expect(lstatSync(join(directory, 'interleaf.log')).isSymbolicLink()).toBe(true);

    rmSync(join(directory, 'interleaf.log'));
    const configured = configureDurableLogging({ directory, maxExportBytes: 32 * 1024 });
    const log = createLogger('app');
    log.info('export password="foo\\"export-escaped-suffix" AKIAIOSFODNN7EXAMPLE', {
      apiKey: 'sk-or-v1-super-secret',
      auth: 'auth-export-secret',
      authentication: 'authentication-export-secret',
      authorization: 'authorization-export-secret',
      privateKey: '-----BEGIN PRIVATE KEY-----\nexport-private-material\n-----END PRIVATE KEY-----',
      documentBody: 'private body',
      stdout: 'raw output',
      path: '/Users/alice/private/project/file.txt',
    });
    await configured.flush();
    const destination = join(directory, 'export.jsonl');
    const exported = await configured.exportTo(destination);
    const exportText = await readFile(destination, 'utf8');
    expect(exported.fileName).toBe('export.jsonl');
    expect(exported.bytes).toBe(Buffer.byteLength(exportText, 'utf8'));
    expect(exportText).not.toContain('super-secret');
    expect(exportText).not.toContain('export-escaped-suffix');
    expect(exportText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(exportText).not.toContain('auth-export-secret');
    expect(exportText).not.toContain('authentication-export-secret');
    expect(exportText).not.toContain('authorization-export-secret');
    expect(exportText).not.toContain('export-private-material');
    expect(exportText).not.toContain('private body');
    expect(exportText).not.toContain('raw output');
    expect(exportText).not.toContain('/Users/alice');
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it('uses a native-dialog-only exporter and reports cancellation without writing', async () => {
    const directory = makeDirectory();
    const sink = new DurableLogSink({ directory });
    let calls = 0;
    const exporter = createDebugLogExporter(sink, (_parent, options) => {
      calls += 1;
      expect(options.defaultPath).toBe('Interleaf-debug-log.jsonl');
      return Promise.resolve({ canceled: true });
    });
    await expect(exporter(null)).resolves.toEqual({ status: 'cancelled' });
    expect(calls).toBe(1);
    expect((await readdir(directory))).toEqual([]);
  });
});
