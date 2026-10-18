import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, statSync, truncateSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutableRegistry } from '@main/agents/executable-registry';
import { hashFileInWorker, MAX_HASH_QUEUE } from '@main/workers/hash-file-worker';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'interleaf-executable-registry-'));
}

describe('ExecutableRegistry integrity hashing', () => {
  it('hashes a large selection off the main event loop', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'large-agent');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      truncateSync(executablePath, 128 * 1024 * 1024);
      chmodSync(executablePath, 0o755);
      const registry = new ExecutableRegistry();

      let eventLoopTurnCompleted = false;
      const registration = registry.register(executablePath);
      const turn = new Promise<void>((resolve) => {
        setImmediate(() => {
          eventLoopTurnCompleted = true;
          resolve();
        });
      });
      await turn;
      expect(eventLoopTurnCompleted).toBe(true);
      const registered = await registration;
      expect(registered.identity.sha256).toMatch(/^[a-f0-9]{64}$/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('fails closed when the worker sees a changed file identity', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'agent');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const details = statSync(executablePath);
      await expect(hashFileInWorker(executablePath, {
        device: details.dev,
        inode: details.ino,
        fileSize: details.size + 1,
        fileMtimeMs: Math.round(details.mtimeMs),
      })).rejects.toThrow(/changed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails safely on a bounded worker timeout without waiting for the production limit', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'agent');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const details = statSync(executablePath);
      await expect(hashFileInWorker(executablePath, {
        device: details.dev,
        inode: details.ino,
        fileSize: details.size,
        fileMtimeMs: Math.round(details.mtimeMs),
      }, { timeoutMs: 0 })).rejects.toThrow(/hashing exceeded its safe time limit/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails safely when a worker errors or exits before returning a digest', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'agent');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const details = statSync(executablePath);
      const expected = {
        device: details.dev,
        inode: details.ino,
        fileSize: details.size,
        fileMtimeMs: Math.round(details.mtimeMs),
      };
      await expect(hashFileInWorker(executablePath, expected, { label: 'executable', testWorkerFailure: 'error' }))
        .rejects.toThrow(/hashing worker failed safely/i);
      await expect(hashFileInWorker(executablePath, expected, { label: 'executable', testWorkerFailure: 'exit' }))
        .rejects.toThrow(/hashing worker exited before completion/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('coalesces identical checks and applies bounded queue backpressure', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'agent');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const details = statSync(executablePath);
      const expected = {
        device: details.dev,
        inode: details.ino,
        fileSize: details.size,
        fileMtimeMs: Math.round(details.mtimeMs),
      };
      const sameCheck = hashFileInWorker(executablePath, expected, { timeoutMs: 10_000, label: 'executable' });
      const coalescedCheck = hashFileInWorker(executablePath, expected, { timeoutMs: 10_000, label: 'document' });
      expect(coalescedCheck).toBe(sameCheck);
      await sameCheck;

      // Occupy 2 active workers and fill MAX_HASH_QUEUE (8) waiters deterministically.
      const files = Array.from({ length: MAX_HASH_QUEUE + 3 }, (_, index) => {
        const file = join(root, `blocked-${String(index)}`);
        writeFileSync(file, `blocked content ${String(index)}\n`);
        const stat = statSync(file);
        return {
          path: file,
          identity: {
            device: stat.dev,
            inode: stat.ino,
            fileSize: stat.size,
            fileMtimeMs: Math.round(stat.mtimeMs),
          },
        };
      });
      const requests = files.map((file) => hashFileInWorker(file.path, file.identity, {
        testWorkerDelayMs: 40,
        label: 'executable',
      }));
      const overflow = requests.pop();
      if (overflow === undefined) throw new Error('overflow request was not created');
      await expect(overflow).rejects.toThrow(/verification is busy/i);
      await Promise.all(requests);

      // All slots and waiters are released after completion; a normal check can
      // immediately acquire a slot and complete.
      await expect(hashFileInWorker(executablePath, expected, { label: 'executable' }))
        .resolves.toMatch(/^[a-f0-9]{64}$/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('recovers slots and inFlight state after identity failure, worker error, exit, and timeout', async () => {
    const root = tempRoot();
    try {
      const executablePath = join(root, 'agent-recovery');
      writeFileSync(executablePath, '#!/bin/sh\necho recovery\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const details = statSync(executablePath);
      const validIdentity = {
        device: details.dev,
        inode: details.ino,
        fileSize: details.size,
        fileMtimeMs: Math.round(details.mtimeMs),
      };

      // 1. Identity failure recovery
      await expect(hashFileInWorker(executablePath, { ...validIdentity, fileSize: validIdentity.fileSize + 10 }))
        .rejects.toThrow(/changed/i);
      await expect(hashFileInWorker(executablePath, validIdentity, { label: 'executable' }))
        .resolves.toMatch(/^[a-f0-9]{64}$/iu);

      // 2. Worker error recovery
      const errorPath = join(root, 'agent-error');
      writeFileSync(errorPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const errorStat = statSync(errorPath);
      const errorIdentity = {
        device: errorStat.dev,
        inode: errorStat.ino,
        fileSize: errorStat.size,
        fileMtimeMs: Math.round(errorStat.mtimeMs),
      };
      await expect(hashFileInWorker(errorPath, errorIdentity, { testWorkerFailure: 'error' }))
        .rejects.toThrow(/failed safely/i);
      await expect(hashFileInWorker(errorPath, errorIdentity))
        .resolves.toMatch(/^[a-f0-9]{64}$/iu);

      // 3. Premature exit recovery
      const exitPath = join(root, 'agent-exit');
      writeFileSync(exitPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const exitStat = statSync(exitPath);
      const exitIdentity = {
        device: exitStat.dev,
        inode: exitStat.ino,
        fileSize: exitStat.size,
        fileMtimeMs: Math.round(exitStat.mtimeMs),
      };
      await expect(hashFileInWorker(exitPath, exitIdentity, { testWorkerFailure: 'exit' }))
        .rejects.toThrow(/exited before completion/i);
      await expect(hashFileInWorker(exitPath, exitIdentity))
        .resolves.toMatch(/^[a-f0-9]{64}$/iu);

      // 4. Timeout recovery
      const timeoutPath = join(root, 'agent-timeout');
      writeFileSync(timeoutPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const timeoutStat = statSync(timeoutPath);
      const timeoutIdentity = {
        device: timeoutStat.dev,
        inode: timeoutStat.ino,
        fileSize: timeoutStat.size,
        fileMtimeMs: Math.round(timeoutStat.mtimeMs),
      };
      await expect(hashFileInWorker(timeoutPath, timeoutIdentity, { timeoutMs: 20, testWorkerDelayMs: 200 }))
        .rejects.toThrow(/exceeded its safe time limit/i);
      await expect(hashFileInWorker(timeoutPath, timeoutIdentity))
        .resolves.toMatch(/^[a-f0-9]{64}$/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
