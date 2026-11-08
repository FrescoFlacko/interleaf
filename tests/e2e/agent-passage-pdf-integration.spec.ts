import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { launchInterleaf, stubOpenDialog } from './helpers';

const marker = 'EXACTPDFINTEGRATIONMARKER';

test('MCP citation resolves a real indexed PDF passage into its mounted text layer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-mcp-pdf-'));
  const path = join(directory, 'source.pdf');
  writeFileSync(path, makePdfFixture({ title: 'PDF citation', pageLines: [...Array.from({ length: 5 }, (_, i) => [`Filler page ${String(i)}`]), [marker]] }));
  const handle = await launchInterleaf();
  try {
    await stubOpenDialog(handle, [path]);
    await handle.window.getByTestId('import-files-button').click();
    await expect(handle.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await handle.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Missing PDF document');
    await handle.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect.poll(() => handle.window.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, doc.id)).toBe('ready');
    await handle.electronApp.evaluate(({ dialog, clipboard, Menu, BrowserWindow }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
      const original = clipboard.writeText;
      const saved = clipboard as typeof clipboard & { copied?: string };
      clipboard.writeText = (value) => { saved.copied = value; return original(value); };
      const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'Agent access')?.submenu?.items[0];
      if (!item) throw new Error('Missing agent menu');
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    });
    const config = await handle.electronApp.evaluate(({ clipboard }) => JSON.parse((clipboard as typeof clipboard & { copied: string }).copied) as { url: string; headers: Record<string, string> });
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'search_library' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_library', arguments: { query: marker }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'pdf-integration', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const rpc = await response.json() as { result: { content: { text: string }[] } };
    const content = rpc.result.content[0];
    if (!content) throw new Error('Missing search result');
    const result = JSON.parse(content.text) as { hits: { documentId: string; link: string }[] };
    const hit = result.hits.find((entry) => entry.documentId === doc.id);
    if (!hit) throw new Error('Missing PDF search hit');
    // Exercise the actual app's registered OS delivery handler; not packaged OS registration.
    await handle.electronApp.evaluate(({ app }, link) => { app.emit('open-url', { preventDefault: () => undefined } as Electron.Event, link); }, hit.link);
    await handle.window.locator(`[data-testid="reader-view"][data-document-id="${doc.id}"]`).waitFor();
    await expect.poll(() => handle.window.evaluate((word) => {
      const layer = document.querySelector('[data-testid="pdf-textlayer-p6"]');
      const viewport = document.querySelector('[data-testid="reader-document-region"]')?.getBoundingClientRect();
      if (!layer || !viewport) return false;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const start = node.textContent?.indexOf(word) ?? -1;
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
        const rect = range.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      }
      return false;
    }, marker)).toBe(true);
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await handle.window.screenshot({ path: join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'mcp-pdf-range.png') });
  } finally { await handle.close(); rmSync(directory, { recursive: true, force: true }); }
});
