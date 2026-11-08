import { expect, test } from '@playwright/test';
import type { BaseWindow as ElectronBaseWindow, MessageBoxOptions } from 'electron';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';
import { captureWindowPng, launchInterleaf, returnToLibrary, stubOpenDialog } from './helpers';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'integration', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };

test('real MCP suggestion requires local approval and refreshes learning and practice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-proposal-'));
  const file = join(dir, 'Evidence.md');
  writeFileSync(file, makeMarkdownFixture({ title: 'Evidence', body: '# Evidence\n\nIntegrationunique passage for source.' }));
  const secondFile = join(dir, 'Contrast.md');
  writeFileSync(secondFile, makeMarkdownFixture({ title: 'Contrast', body: '# Contrast\n\nContrastunique passage for comparison.' }));
  const originalHashes = [file, secondFile].map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'));
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [file, secondFile]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const doc = documents.find((entry) => entry.title === 'Evidence');
    const secondDoc = documents.find((entry) => entry.title === 'Contrast');
    if (!doc || !secondDoc) throw new Error('Missing documents');
    await app.window.getByTestId(`read-doc-${secondDoc.id}`).click();
    await expect.poll(() => app.window.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, secondDoc.id)).toBe('ready');
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect.poll(() => app.window.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, doc.id)).toBe('ready');
    await app.electronApp.evaluate(({ BaseWindow, dialog, clipboard }) => {
      const original = clipboard.writeText;
      const saved = clipboard as typeof clipboard & { copied?: string };
      clipboard.writeText = (value) => { saved.copied = value; return original(value); };
      dialog.showMessageBox = ((parentOrOptions: ElectronBaseWindow | MessageBoxOptions, maybeOptions?: MessageBoxOptions) => {
        const options = parentOrOptions instanceof BaseWindow ? maybeOptions : parentOrOptions;
        const title = options?.title ?? '';
        Reflect.set(globalThis, 'integrationLastDialog', title);
        return Promise.resolve({ response: title === 'Review suggestion' ? (options?.buttons?.indexOf('Accept') ?? -1) : 1, checkboxChecked: false });
      });
    });
    const clickMenu = async (index: number): Promise<void> => app.electronApp.evaluate(({ Menu, BrowserWindow }, which) => {
      const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'Agent access')?.submenu?.items[which];
      if (!item) throw new Error('Missing menu action');
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    }, index);
    await clickMenu(0);
    const config = await app.electronApp.evaluate(({ clipboard }) => JSON.parse((clipboard as typeof clipboard & { copied: string }).copied) as { url: string; headers: Record<string, string> });
    async function call(name: string, args: object): Promise<{ isError: boolean; content: { text: string }[] }> {
      const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: meta } }) });
      const body = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
      return body.result;
    }
    const search = await call('search_library', { query: 'Integrationunique' });
    const searchResult = JSON.parse(search.content[0]!.text) as { coverage: { totalDocuments: number; indexedDocuments: number }; hits: { documentId: string; documentHash: string; chunkId: string; location: { format: string; blockIndex: number } }[] };
    expect(searchResult.coverage).toEqual({ totalDocuments: 2, indexedDocuments: 2 });
    const hit = searchResult.hits.find((item) => item.documentId === doc.id);
    if (hit?.location.format !== 'markdown') throw new Error('Missing indexed passage');
    const source = { documentId: hit.documentId, documentHash: hit.documentHash, chunkId: hit.chunkId,
      anchor: { format: 'markdown' as const, blockIndex: hit.location.blockIndex, quote: { exact: 'Integrationunique', prefix: '', suffix: '' } } };
    expect((await call('submit_proposal', { kind: 'primer', source, text: 'Accepted primer text.' })).isError).toBe(true);
    await clickMenu(1);
    await expect.poll(() => app.electronApp.evaluate(() => String(Reflect.get(globalThis, 'integrationLastDialog')))).toBe('Allow suggestions');
    expect((await call('submit_proposal', { kind: 'primer', source, text: 'Accepted primer text.' })).isError).toBe(false);
    await clickMenu(2);
    await expect(app.window.getByTestId('learning-margin')).toContainText('Accepted primer text.');
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'proposal-margin.png'));
    const contrast = await call('search_library', { query: 'Contrastunique' });
    const contrastResult = JSON.parse(contrast.content[0]!.text) as typeof searchResult;
    const secondHit = contrastResult.hits.find((item) => item.documentId === secondDoc.id);
    if (secondHit?.location.format !== 'markdown') throw new Error('Missing comparison passage');
    const secondSource = { documentId: secondHit.documentId, documentHash: secondHit.documentHash, chunkId: secondHit.chunkId,
      anchor: { format: 'markdown' as const, blockIndex: secondHit.location.blockIndex, quote: { exact: 'Contrastunique', prefix: '', suffix: '' } } };
    for (const item of [source, secondSource]) {
      const passage = await call('get_passage', { documentId: item.documentId, documentHash: item.documentHash, chunkId: item.chunkId });
      expect(JSON.parse(passage.content[0]!.text)).toMatchObject({ documentId: item.documentId, documentHash: item.documentHash, chunkId: item.chunkId });
      await app.window.evaluate(async (input) => { await window.interleafAPI.annotations.create({ documentId: input.documentId, type: 'highlight', color: 'yellow', selectedText: input.anchor.quote.exact, anchor: input.anchor }); }, item);
      const annotations = await call('get_annotations', { documentId: item.documentId });
      expect(annotations.content[0]!.text).toContain(item.anchor.quote.exact);
      expect((await call('get_reading_position', { documentId: item.documentId })).isError).toBe(false);
      expect((await call('get_reading_history', { documentId: item.documentId })).isError).toBe(false);
    }
    expect((await call('submit_proposal', { kind: 'conflict', source, secondSource, text: 'Compare these sources.' })).isError).toBe(false);
    await clickMenu(2);
    const margin = app.window.getByTestId('learning-margin');
    await margin.getByRole('button', { name: 'Show all learning' }).click();
    await expect(margin).toContainText('Compare these sources.');
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'proposal-conflict.png'));
    await margin.getByRole('button', { name: 'Open other source' }).click();
    await expect(app.window.getByTestId('reader-view')).toHaveAttribute('data-document-id', secondDoc.id);
    await expect(app.window.getByRole('status').filter({ hasText: 'Source opened.' })).toBeVisible();
    await returnToLibrary(app);
    await app.window.getByRole('button', { name: 'Review practice', exact: true }).click();
    await expect(app.window.getByText('No cards are due.')).toBeVisible();
    expect((await call('submit_proposal', { kind: 'card', source, text: 'What is the indexed word?' })).isError).toBe(false);
    await clickMenu(2);
    await expect.poll(async () => (await app.window.evaluate(() => window.interleafAPI.practice.due(20))).length).toBe(1);
    await expect(app.window.getByRole('heading', { name: 'What is the indexed word?' })).toBeVisible();
    const cards = await app.window.evaluate(() => window.interleafAPI.practice.due(20));
    expect(cards[0]).toMatchObject({ question: 'What is the indexed word?', evidence: 'Integrationunique', sourceState: 'available' });
    expect([file, secondFile].map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'))).toEqual(originalHashes);
    expect((await call('submit_proposal', { kind: 'primer', source, text: 'Should remain pending.' })).isError).toBe(false);
    const db = new DatabaseSync(join(app.userDataDir, 'database', 'interleaf.sqlite'), { readOnly: true });
    let managedPath: string;
    try {
      const row = db.prepare('SELECT file_path FROM documents WHERE id = ?').get(doc.id) as { file_path: string };
      managedPath = row.file_path;
    } finally { db.close(); }
    if (!managedPath.startsWith(`${join(app.userDataDir, 'library')}/`)) throw new Error('Expected fixture-owned managed copy');
    rmSync(managedPath);
    const missingPassage = await call('get_passage', { documentId: source.documentId, documentHash: source.documentHash, chunkId: source.chunkId });
    expect(missingPassage.isError).toBe(true);
    await clickMenu(2);
    await expect.poll(() => app.electronApp.evaluate(() => String(Reflect.get(globalThis, 'integrationLastDialog')))).toBe('Suggestion not accepted');
    await app.window.getByLabel('Your answer').fill('An answer');
    await app.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
    await app.window.getByRole('button', { name: 'Open source passage', exact: true }).click();
    await expect(app.window.getByText('The source could not be opened. It may be missing or changed.')).toBeVisible();
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'missing-source.png'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
