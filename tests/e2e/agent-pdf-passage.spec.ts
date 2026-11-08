import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdfFixture } from '../fixtures/document-fixtures';

const marker = 'EXACTPDFREVIEWMARKER';
async function pdfState(page: Page) {
  return page.evaluate((word) => {
    const overlay = document.querySelector('[data-testid="reader-error"]');
    const layer = document.querySelector('[data-testid="pdf-textlayer-p6"]');
    const scroller = document.querySelector('[data-testid="pdf-scroll-container"]');
    if (!layer || !scroller) return { visible: false, overlay: !!overlay, ready: false, text: false };
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf(word) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + word.length);
      const rect = range.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      return { visible: !overlay && rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom,
        overlay: !!overlay, ready: (layer as HTMLElement).dataset.pdfTextReady === 'true', text: true, top: rect.top, bottom: rect.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    }
    return { visible: false, overlay: !!overlay, ready: (layer as HTMLElement).dataset.pdfTextReady === 'true', text: false };
  }, marker);
}

test('cold PDF MCP links wait for completed text and show the exact target without an error overlay', async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-pdf-passage-e2e-'));
  const file = join(dir, 'six-page.pdf');
  writeFileSync(file, makePdfFixture({ title: 'Reviewer sixth page PDF', pageLines: Array.from({ length: 6 }, (_, p) => [...Array.from({ length: 30 }, (_, i) => `Page ${String(p + 1)} filler line ${String(i)}`), p === 5 ? marker : 'Ordinary closing line']) }));
  const env = { ...(process.env.DISPLAY === undefined ? {} : { DISPLAY: process.env.DISPLAY }), ...(process.env.XAUTHORITY === undefined ? {} : { XAUTHORITY: process.env.XAUTHORITY }), PATH: '/usr/bin:/bin', HOME: dir, NODE_ENV: 'test', INTERLEAF_USER_DATA: dir, INTERLEAF_ISOLATED_CLI_PATH: '1' };
  const launch = (link?: string): Promise<ElectronApplication> => _electron.launch({ args: ['--no-sandbox', 'out/main/index.js', ...(link ? [link] : [])], env });
  const secondary = (link: string): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(join(process.cwd(), 'node_modules/electron/dist/electron'), ['--no-sandbox', 'out/main/index.js', link], { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`Second instance exited ${String(code)}`)); });
  });
  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.getByTestId('library-view').waitFor();
    const later = page.getByRole('button', { name: 'Finish later' });
    if (await later.isVisible()) await later.click();
    await app.evaluate(({ dialog, clipboard }, path) => {
      const original = clipboard.writeText;
      const saved = clipboard as typeof clipboard & { copied?: string };
      clipboard.writeText = (value) => { saved.copied = value; return original(value); };
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
    }, file);
    await page.getByTestId('import-files-button').click();
    await page.getByTestId('success-banner').waitFor();
    const [doc] = await page.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Missing PDF fixture');
    await page.getByTestId(`read-doc-${doc.id}`).click();
    await expect.poll(() => page.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, doc.id), { timeout: 40_000 }).toBe('ready');
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'Agent access')?.submenu?.items[0];
      if (!item) throw new Error('Missing agent menu');
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    });
    const config = await app.evaluate(({ clipboard }) => JSON.parse((clipboard as typeof clipboard & { copied: string }).copied) as { url: string; headers: Record<string, string> });
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'search_library' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_library', arguments: { query: marker }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'pdf-passage-e2e', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const rpc = await response.json() as { result: { content: { text: string }[] } };
    const content = rpc.result.content[0];
    if (!content) throw new Error('Missing MCP result');
    const result = JSON.parse(content.text) as { hits: { documentId: string; link: string; location: { pageIndex: number } }[] };
    const hit = result.hits.find((entry) => entry.documentId === doc.id);
    if (hit?.location.pageIndex !== 5) throw new Error('Missing sixth-page search hit');
    await app.close(); app = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      app = await launch(hit.link);
      const cold = await app.firstWindow();
      await cold.locator(`[data-testid="reader-view"][data-document-id="${doc.id}"]`).waitFor();
      try {
        await expect.poll(() => pdfState(cold), { timeout: 15_000 }).toMatchObject({ visible: true, overlay: false });
      } catch (error) {
        console.log('cold PDF failure state:', JSON.stringify(await pdfState(cold)));
        throw error;
      }
      await cold.evaluate(() => new Promise<void>((resolve) => { let count = 0; const frame = (): void => { count += 1; if (count === 40) resolve(); else requestAnimationFrame(frame); }; requestAnimationFrame(frame); }));
      const state = await pdfState(cold);
      expect(state).toMatchObject({ visible: true, overlay: false });
      console.log(`cold PDF ${String(attempt)}:`, JSON.stringify(state));
      if (process.env.INTERLEAF_CORRECTION_EVIDENCE) await cold.screenshot({ path: join(process.env.INTERLEAF_CORRECTION_EVIDENCE, `pdf-cold-${String(attempt)}.png`) });
      if (attempt === 3) {
        await cold.setViewportSize({ width: 850, height: 650 });
        await cold.getByTestId('pdf-scroll-container').evaluate((element) => { element.scrollTop = 0; });
        await expect.poll(() => pdfState(cold)).toMatchObject({ visible: false });
        await secondary(hit.link);
        try {
        await expect.poll(() => pdfState(cold), { timeout: 15_000 }).toMatchObject({ visible: true, overlay: false });
      } catch (error) {
        console.log('cold PDF failure state:', JSON.stringify(await pdfState(cold)));
        throw error;
      }
        console.log('resized PDF:', JSON.stringify(await pdfState(cold)));
        if (process.env.INTERLEAF_CORRECTION_EVIDENCE) await cold.screenshot({ path: join(process.env.INTERLEAF_CORRECTION_EVIDENCE, 'pdf-reflow.png') });
      }
      await app.close(); app = null;
    }
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
