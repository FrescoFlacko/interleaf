import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const marker = 'EXACTPASSAGEREVIEWMARKER';

async function markerBounds(page: Page): Promise<{ visible: boolean; top: number; bottom: number; viewportTop: number; viewportBottom: number } | null> {
  return page.evaluate((word) => {
    const block = document.querySelector('[data-markdown-block="1"]');
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const offset = node.textContent?.indexOf(word) ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + word.length);
      const rect = range.getBoundingClientRect();
      const viewport = block.closest('[data-testid="pdf-viewport-container"]')?.getBoundingClientRect();
      const viewportTop = Math.max(0, viewport?.top ?? 0);
      const viewportBottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight);
      return { visible: rect.height > 0 && rect.top >= viewportTop && rect.bottom <= viewportBottom, top: rect.top, bottom: rect.bottom, viewportTop, viewportBottom };
    }
    return null;
  }, marker);
}

async function visibleMarker(page: Page): Promise<boolean> {
  return (await markerBounds(page))?.visible ?? false;
}

test('real cold and warm passage links reveal the exact range in a long reflowed block', async () => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-passage-e2e-'));
  const file = join(dir, 'Long-source.md');
  writeFileSync(file, `# Reviewer source\n\n${'Filler words stay in one long paragraph. '.repeat(400)}${marker}${' Filler words continue in that same paragraph. '.repeat(600)} finishes this paragraph.\n`);
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
    expect(doc).toBeDefined();
    if (!doc) throw new Error('Missing imported fixture');
    await page.getByTestId(`read-doc-${doc.id}`).click();
    await expect.poll(() => page.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, doc.id)).toBe('ready');
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'Agent access')?.submenu?.items[0];
      if (!item) throw new Error('Missing agent menu');
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    });
    const config = await app.evaluate(({ clipboard }) => JSON.parse((clipboard as typeof clipboard & { copied: string }).copied) as { url: string; headers: Record<string, string> });
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'search_library' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_library', arguments: { query: marker }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'passage-e2e', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const rpc = await response.json() as { result: { content: { text: string }[] } };
    const content = rpc.result.content[0];
    if (!content) throw new Error('Missing MCP result');
    const result = JSON.parse(content.text) as { hits: { documentId: string; link: string }[] };
    const hit = result.hits.find((entry) => entry.documentId === doc.id);
    if (!hit) throw new Error('Missing MCP search hit');
    await page.getByTestId('nav-all-documents').click();
    await secondary(hit.link);
    await page.locator(`[data-testid="reader-view"][data-document-id="${doc.id}"]`).waitFor();
    await expect.poll(() => visibleMarker(page)).toBe(true);
    console.log('warm range:', JSON.stringify(await markerBounds(page)));
    if (process.env.INTERLEAF_CORRECTION_EVIDENCE) await page.screenshot({ path: join(process.env.INTERLEAF_CORRECTION_EVIDENCE, 'warm-exact-passage.png') });
    await app.close();
    app = await launch(hit.link);
    const cold = await app.firstWindow();
    await cold.locator(`[data-testid="reader-view"][data-document-id="${doc.id}"]`).waitFor();
    await expect.poll(() => visibleMarker(cold)).toBe(true);
    console.log('cold range:', JSON.stringify(await markerBounds(cold)));
    if (process.env.INTERLEAF_CORRECTION_EVIDENCE) await cold.screenshot({ path: join(process.env.INTERLEAF_CORRECTION_EVIDENCE, 'cold-exact-passage.png') });
    await cold.setViewportSize({ width: 850, height: 650 });
    await cold.locator('[data-testid="markdown-scroll-container"]').evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => visibleMarker(cold)).toBe(false);
    await secondary(hit.link);
    await expect.poll(() => visibleMarker(cold)).toBe(true);
    console.log('reflow range:', JSON.stringify(await markerBounds(cold)));
    if (process.env.INTERLEAF_CORRECTION_EVIDENCE) await cold.screenshot({ path: join(process.env.INTERLEAF_CORRECTION_EVIDENCE, 'reflow-exact-passage.png') });
    const [prefix, fragment] = hit.link.split('#');
    if (!prefix || !fragment) throw new Error('Malformed search link');
    const stale = JSON.parse(Buffer.from(fragment, 'base64url').toString('utf8')) as { documentHash: string };
    stale.documentHash = 'stale';
    await secondary(`${prefix}#${Buffer.from(JSON.stringify(stale)).toString('base64url')}`);
    await expect(cold.getByTestId('open-file-error')).toContainText(/Passage is unavailable or its document has changed/);
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
