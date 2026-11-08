import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Dialog } from 'electron';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { ReadingPositionRepository } from '@main/db/repositories/reading-position-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { ProposalRepository } from '@main/agent-access/proposal-repository';
import { AgentAccessController } from '@main/agent-access/controller';
import { createActiveWork } from '@main/app/active-work';
import { restartToUpdate } from '@main/updates/update-runtime';
import { ShutdownBarrier } from '@main/app/shutdown-barrier';

function setup() {
  const database = InterleafDatabase.open(':memory:');
  runMigrations(database);
  new DocumentRepository(database).insert({ id: 'doc', title: 'Fixture', author: null, format: 'markdown', filePath: '/fixture.md', storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: 'hash', pageCount: 1 });
  const search = new SearchRepository(database);
  const generation = search.begin('doc', 'hash');
  search.append('doc', 'hash', generation.generationId, [{ ordinal: 0, text: 'A chosen passage.', location: { format: 'markdown', blockIndex: 0, characterStart: 0, characterEnd: 17 }, heading: null, pageLabel: null }]);
  search.complete('doc', 'hash', generation.generationId);
  const hit = search.search('doc', 'chosen')[0];
  if (!hit) throw new Error('missing fixture hit');
  const annotations = new AnnotationRepository(database);
  const proposals = new ProposalRepository(database, { annotation: () => 'unused' });
  proposals.submit({ kind: 'annotation', text: 'Note', source: { documentId: 'doc', documentHash: 'hash', chunkId: hit.chunkId, anchor: { format: 'markdown', blockIndex: 0, characterStart: 2, characterEnd: 8, quote: { exact: 'chosen', prefix: '', suffix: '' } } } });
  return { database, search, annotations, positions: new ReadingPositionRepository(database), proposals };
}

describe('agent access shutdown ownership', () => {
  it('counts native review before awaiting, blocks update, and fences a late accept after close', async () => {
    const fixture = setup();
    let answer!: (value: { response: number; checkboxChecked: boolean }) => void;
    const deferred = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => { answer = resolve; });
    const dialog = { showMessageBox: vi.fn(() => deferred) } as Pick<Dialog, 'showMessageBox'>;
    const controller = new AgentAccessController({ ...fixture, dialog, sourceHealthy: () => Promise.resolve(true), clipboard: { writeText: vi.fn() }, parent: () => null, openSource: vi.fn() });
    const activeWork = createActiveWork({ agentSessions: [() => controller.liveWork()], chatStreams: [], imports: [], closeAdmission: [() => { controller.closeAdmission(); }] });
    try {
      await controller.start();
      const review = controller.review();
      expect(activeWork.probe().agentSessions).toBe(1);
      const prepareInstall = vi.fn();
      const result = await restartToUpdate({ prepareInstall, cancelPreparedInstall: vi.fn() }, { activeWork, requestQuitForUpdate: vi.fn() });
      expect(result.outcome).toBe('blocked');
      expect(prepareInstall).not.toHaveBeenCalled();
      activeWork.closeAdmission();
      await controller.close();
      await review;
      expect(controller.liveWork()).toBe(1); // the native dismissal has not settled yet
      expect(fixture.annotations.page('doc').total).toBe(0);
      answer({ response: 3, checkboxChecked: false });
      await deferred;
      await Promise.resolve();
      expect(controller.liveWork()).toBe(0);
      expect(fixture.annotations.page('doc').total).toBe(0);
      expect(fixture.proposals.list()).toHaveLength(1);
      await controller.review();
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    } finally { await controller.close(); fixture.database.close(); }
  });

  it('rechecks native work started while an update was being prepared', async () => {
    const fixture = setup();
    let finishPrepare!: (value: { version: string; install: () => void }) => void;
    const prepared = new Promise<{ version: string; install: () => void }>((resolve) => { finishPrepare = resolve; });
    const dialog = { showMessageBox: vi.fn(() => new Promise(() => undefined)) } as Pick<Dialog, 'showMessageBox'>;
    const controller = new AgentAccessController({ ...fixture, dialog, sourceHealthy: () => Promise.resolve(true), clipboard: { writeText: vi.fn() }, parent: () => null, openSource: vi.fn() });
    const activeWork = createActiveWork({ agentSessions: [() => controller.liveWork()], chatStreams: [], imports: [], closeAdmission: [() => { controller.closeAdmission(); }] });
    const cancelPreparedInstall = vi.fn();
    const requestQuitForUpdate = vi.fn();
    try {
      await controller.start();
      const update = restartToUpdate({ prepareInstall: () => prepared, cancelPreparedInstall }, { activeWork, requestQuitForUpdate });
      const review = controller.review();
      finishPrepare({ version: '1.2.3', install: vi.fn() });
      expect((await update).outcome).toBe('blocked');
      expect(cancelPreparedInstall).toHaveBeenCalledOnce();
      expect(requestQuitForUpdate).not.toHaveBeenCalled();
      await controller.close();
      await review;
    } finally { await controller.close(); fixture.database.close(); }
  });

  it('closes admission before the quit handshake and fences its pending review', async () => {
    const fixture = setup();
    let answer!: (value: { response: number; checkboxChecked: boolean }) => void;
    const deferred = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => { answer = resolve; });
    const dialog = { showMessageBox: vi.fn(() => deferred) } as Pick<Dialog, 'showMessageBox'>;
    const controller = new AgentAccessController({ ...fixture, dialog, sourceHealthy: () => Promise.resolve(true), clipboard: { writeText: vi.fn() }, parent: () => null, openSource: vi.fn() });
    const sent = vi.fn();
    const window = { isDestroyed: () => false, close: vi.fn(), webContents: { send: sent } };
    const barrier = new ShutdownBarrier({ mainWindow: () => window, drain: () => controller.close(), closeAdmission: () => { controller.closeAdmission(); }, hasLiveServices: () => true, quit: vi.fn(), log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, handshakeTimeoutMs: 10 });
    try {
      await controller.start();
      const review = controller.review();
      barrier.handleBeforeQuit({ preventDefault: vi.fn() });
      expect(sent).toHaveBeenCalledOnce();
      await controller.review();
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      await review;
      await barrier.shutdown();
      answer({ response: 3, checkboxChecked: false });
      await deferred;
      expect(fixture.annotations.page('doc').total).toBe(0);
    } finally { await controller.close(); fixture.database.close(); }
  });

  it('does not leave a listener behind when close races startup', async () => {
    const fixture = setup();
    const dialog = { showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })) } as Pick<Dialog, 'showMessageBox'>;
    const controller = new AgentAccessController({ ...fixture, dialog, sourceHealthy: () => Promise.resolve(true), clipboard: { writeText: vi.fn() }, parent: () => null, openSource: vi.fn() });
    try {
      const start = controller.start();
      const close = controller.close();
      await Promise.all([start, close]);
      await controller.copyConnection();
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
      expect(controller.liveWork()).toBe(0);
    } finally { await controller.close(); fixture.database.close(); }
  });

  it('owns and aborts an incomplete HTTP request before draining', async () => {
    const fixture = setup();
    let copied = '';
    const dialog = { showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })) } as Pick<Dialog, 'showMessageBox'>;
    const controller = new AgentAccessController({ ...fixture, dialog, sourceHealthy: () => Promise.resolve(true), clipboard: { writeText: (value: string) => { copied = value; return Promise.resolve(); } }, parent: () => null, openSource: vi.fn() });
    try {
      await controller.start();
      await controller.copyConnection();
      const connection = JSON.parse(copied) as { url: string; headers: { Authorization: string } };
      const started = new Promise<void>((resolve, reject) => {
        const req = request(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': '100' } });
        req.on('error', () => { resolve(); });
        req.on('response', () => { reject(new Error('incomplete request unexpectedly processed')); });
        req.write('{');
      });
      for (let i = 0; i < 100 && controller.liveWork() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(controller.liveWork()).toBe(1);
      controller.closeAdmission();
      await controller.close();
      await started;
      expect(controller.liveWork()).toBe(0);
      expect(fixture.proposals.list()).toHaveLength(1);
    } finally { await controller.close(); fixture.database.close(); }
  });
});
