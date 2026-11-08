import { expect, it, vi } from 'vitest';
import type { AIProviderStatus } from '@shared/types/ai';
import type { AIProvider, ProviderChatRequest } from '@main/ai/providers/types';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { PracticeRepository } from '@main/practice/repository';
import { PracticeChecker } from '@main/practice/checker';

it('sends only the selected card evidence after an explicit request and excludes unsafe providers', async () => {
  const db = InterleafDatabase.open(':memory:');
  try {
    runMigrations(db);
    db.raw.prepare(`INSERT INTO documents (id,title,format,file_path,storage_mode,file_size,file_mtime_ms,file_hash)
      VALUES ('doc','Book','pdf','/fixture','managed',1,1,'hash')`).run();
    const highlight = new AnnotationRepository(db).create({ documentId: 'doc', type: 'highlight', selectedText: 'Evidence A', color: 'yellow',
      anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'Evidence A', prefix: '', suffix: '' } } });
    db.raw.prepare(`INSERT INTO documents (id,title,format,file_path,storage_mode,file_size,file_mtime_ms,file_hash)
      VALUES ('other','Other','pdf','/other','managed',1,1,'other-hash')`).run();
    const other = new AnnotationRepository(db).create({ documentId: 'other', type: 'highlight', selectedText: 'PRIVATE OTHER BOOK', color: 'yellow',
      anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'PRIVATE OTHER BOOK', prefix: '', suffix: '' } } });
    const repo = new PracticeRepository(db);
    repo.createFromHighlight({ documentId: 'other', annotationId: other.id, question: 'Other?' });
    const card = repo.createFromHighlight({ documentId: 'doc', annotationId: highlight.id, question: 'Why?' });
    const status: AIProviderStatus = { id: 'claude', name: 'Fixture', available: true, installed: true, authentication: 'connected', version: null, errorMessage: null,
      models: [{ id: 'model', name: 'Fixture', contextWindow: 10000, maxOutputTokens: 1000, supportsStreaming: true }],
      capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false } };
    const requests: ProviderChatRequest[] = [];
    const provider: AIProvider = { id: 'claude', name: 'Fixture', capabilities: status.capabilities, detect: () => Promise.resolve(status), listModels: () => Promise.resolve(status.models),
      streamChat: async function* (request) { await Promise.resolve(); requests.push(request); yield { type: 'token', token: 'Compare this.' }; yield { type: 'done' }; }, cancel: () => Promise.resolve() };
    const requireProvider = vi.fn(() => provider);
    let healthy = true;
    let failAfterReadiness = false;
    let delayed = false;
    const healthStarted = Promise.withResolvers<void>();
    const healthFinished = Promise.withResolvers<boolean>();
    const checker = new PracticeChecker(repo, { require: requireProvider, getStatus: () => Promise.resolve(status), resolveModel: () => { if (failAfterReadiness) healthy = false; return Promise.resolve(status.models[0]!); } }, async () => {
      if (!delayed) return healthy;
      healthStarted.resolve();
      return healthFinished.promise;
    });
    expect(requests).toHaveLength(0);
    expect(await checker.check(1, card.id, 'My answer', 'codex', 'model')).toBeNull();
    expect(requireProvider).not.toHaveBeenCalled();
    expect(await checker.check(1, card.id, 'My answer', 'claude', 'model')).toBe('Compare this.');
    expect(JSON.parse(requests[0]!.userMessage)).toEqual({ question: 'Why?', answer: 'My answer', source: 'Evidence A', sourceKind: 'native' });
    expect(requests[0]).toMatchObject({ webSearch: false, history: [], sources: [] });
    expect(JSON.stringify(requests[0])).not.toContain('PRIVATE OTHER BOOK');
    healthy = false;
    expect(await checker.check(1, card.id, 'My answer', 'claude', 'model')).toBeNull();
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => { expect(checker.activeCount()).toBe(0); });
    healthy = true;
    failAfterReadiness = true;
    expect(await checker.check(1, card.id, 'My answer', 'claude', 'model')).toBeNull();
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => { expect(checker.activeCount()).toBe(0); });
    failAfterReadiness = false;
    delayed = true;
    const pending = checker.check(2, card.id, 'My answer', 'claude', 'model');
    await healthStarted.promise;
    checker.cancel(2);
    expect(checker.activeCount()).toBe(1);
    healthFinished.resolve(true);
    expect(await pending).toBeNull();
    await vi.waitFor(() => { expect(checker.activeCount()).toBe(0); });
    expect(requests).toHaveLength(1);
    await checker.shutdown();
  } finally { db.close(); }
});

it('keeps cancellation cleanup counted until the provider stop settles', async () => {
  const db = InterleafDatabase.open(':memory:');
  try {
    runMigrations(db);
    db.raw.prepare(`INSERT INTO documents (id,title,format,file_path,storage_mode,file_size,file_mtime_ms,file_hash)
      VALUES ('doc','Book','pdf','/fixture','managed',1,1,'hash')`).run();
    const highlight = new AnnotationRepository(db).create({ documentId: 'doc', type: 'highlight', selectedText: 'Text', color: 'yellow',
      anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'Text', prefix: '', suffix: '' } } });
    const repo = new PracticeRepository(db);
    const card = repo.createFromHighlight({ documentId: 'doc', annotationId: highlight.id, question: 'Why?' });
    const status: AIProviderStatus = { id: 'claude', name: 'Fixture', available: true, installed: true, authentication: 'connected', version: null, errorMessage: null,
      models: [{ id: 'model', name: 'Fixture', contextWindow: 10000, maxOutputTokens: 1000, supportsStreaming: true }],
      capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false } };
    const started = Promise.withResolvers<undefined>();
    const stopped = Promise.withResolvers<undefined>();
    const stream = Promise.withResolvers<undefined>();
    const provider: AIProvider = { id: 'claude', name: 'Fixture', capabilities: status.capabilities,
      detect: () => Promise.resolve(status), listModels: () => Promise.resolve(status.models),
      streamChat: async function* () { started.resolve(undefined); await stream.promise; yield { type: 'done' }; },
      cancel: () => stopped.promise };
    const checker = new PracticeChecker(repo, { require: () => provider, getStatus: () => Promise.resolve(status), resolveModel: () => Promise.resolve(status.models[0]!) }, async () => true);
    const work = checker.check(1, card.id, 'Answer', 'claude', 'model');
    await started.promise;
    checker.cancel(1);
    expect(await work).toBeNull();
    expect(checker.activeCount()).toBe(1);
    stopped.resolve(undefined);
    await vi.waitFor(() => { expect(checker.activeCount()).toBe(0); });
    stream.resolve(undefined);
    await checker.shutdown();
  } finally { db.close(); }
});
