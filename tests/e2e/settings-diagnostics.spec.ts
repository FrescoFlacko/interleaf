import { expect, test, type Locator } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dismissOnboardingIfOpen, launchInterleaf, type AppHandle } from './helpers';
import { chooseListboxValue } from './listbox';
import { createDiagnosticsClaudeFixture } from './diagnostics-claude-fixture';

/**
 * Private diagnostics end to end in a real Electron window: prepare and review,
 * the no-provider state, narrow and 200% zoom layouts, expired and write-failure recovery, analysis through
 * the real Claude Code CLI adapter (an offline `claude` fixture on the
 * launch PATH, never the network or a paid model) and export through the
 * native save dialog.
 *
 * Set `INTERLEAF_DIAGNOSTICS_SCREENSHOTS` to a directory to keep the screens.
 */

const APP_VERSION = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
const HOME_CANARY = 'CANARY-HOME-8f2c1d';
const PWNED_FLAG = '__interleafDiagnosticsPwned';

const ANSWER = [
  'Observations: one import failure is counted in the log.',
  'Likely area: imports.',
  `<img src="x" onerror="window.${PWNED_FLAG}=1">`,
  'Run this: ```bash',
  'rm -rf ~/Library',
  '```',
];

/** The arguments the main process must own on every diagnostics CLI turn. */
const HARDENED_ARGS = ['[--tools][]', '[--safe-mode]', '[--disable-slash-commands]', '[--strict-mcp-config]', '[--no-session-persistence]'];

async function shoot(app: AppHandle, target: Locator, name: string): Promise<void> {
  const dir = process.env.INTERLEAF_DIAGNOSTICS_SCREENSHOTS;
  if (dir === undefined || dir.length === 0) return;
  await target.scrollIntoViewIfNeeded();
  await app.window.evaluate(() => document.fonts.ready);
  // Electron's own capture, because Playwright's page screenshot ignores the window's zoom factor.
  const png = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window');
    return (await win.webContents.capturePage()).toPNG().toString('base64');
  });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(png, 'base64'));
}

type Layout = { readonly name: string; readonly width: number; readonly height: number; readonly zoom: number };

/** 960 is the main window's minimum width; at 200% zoom it leaves a 480px-wide page. */
const LAYOUTS: readonly Layout[] = [
  { name: 'narrow', width: 960, height: 900, zoom: 1 },
  { name: 'zoom-200', width: 1440, height: 1000, zoom: 2 },
  { name: 'narrow-zoom-200', width: 960, height: 900, zoom: 2 },
];

async function setLayout(app: AppHandle, layout: Layout): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window');
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(zoom);
  }, layout);
  await app.window.waitForFunction((width) => Math.abs(window.innerWidth - width) <= 2, Math.round(layout.width / layout.zoom));
}

/**
 * Neither the window, the Settings content area nor anything in the panel may
 * scroll sideways. (Below md the Settings rail is a deliberately scrollable tab strip.)
 */
async function expectNoHorizontalOverflow(app: AppHandle, modal: Locator): Promise<void> {
  expect(await app.window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const overflowing = await modal.getByTestId('settings-diagnostics').evaluate((section) => {
    const scrollAreas: Element[] = [...section.querySelectorAll('*')];
    for (let el = section.parentElement; el !== null; el = el.parentElement) scrollAreas.push(el);
    return scrollAreas
      .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.getAttribute('data-testid') ?? el.tagName);
  });
  expect(overflowing).toEqual([]);
  const right = await modal.getByTestId('settings-diagnostics').evaluate((el) => el.getBoundingClientRect().right - window.innerWidth);
  expect(right).toBeLessThanOrEqual(0);
}

/** Checks and captures each layout, then restores the 1440x1000 desktop window. */
async function checkLayouts(app: AppHandle, modal: Locator, target: Locator): Promise<void> {
  for (const view of LAYOUTS) {
    await setLayout(app, view);
    await expectNoHorizontalOverflow(app, modal);
    await shoot(app, target, `after-settings-diagnostics-${view.name}`);
  }
  await setLayout(app, { name: 'desktop', width: 1440, height: 1000, zoom: 1 });
}

/** Main keeps one report at a time, so collecting a replacement and discarding it leaves the shown handle expired. */
async function expireShownReport(app: AppHandle): Promise<void> {
  await app.window.evaluate(async () => {
    const api = Reflect.get(window, 'interleafAPI');
    const replacement = await api.diagnostics.collect();
    await api.diagnostics.discard(replacement.handle);
  });
}

async function stubSaveDialog(app: AppHandle, filePath: string): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, filePath);
}

test('diagnostics: collect, review, analyze through the tool-free Claude CLI and export the exact report', async () => {
  const work = mkdtempSync(join(tmpdir(), 'interleaf-diagnostics-e2e-'));
  const isolatedHome = join(work, 'home');
  mkdirSync(isolatedHome);
  writeFileSync(join(isolatedHome, `${HOME_CANARY}.txt`), HOME_CANARY);
  const exportPath = join(work, 'exported-report.md');
  const unwritablePath = join(work, 'missing-folder', 'report.md');
  const claude = createDiagnosticsClaudeFixture(ANSWER);

  const app = await launchInterleaf({ isolatedHome, binDir: claude.binDir });
  try {
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No window');
      win.unmaximize();
      win.setContentSize(1440, 1000);
    });
    await dismissOnboardingIfOpen(app);

    await app.window.getByTestId('open-settings').click();
    const modal = app.window.getByTestId('ai-providers-settings-modal');
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    const section = modal.getByTestId('settings-diagnostics');
    await expect(section.getByRole('heading', { name: 'Private diagnostics' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Export Debug Log' })).toBeVisible();
    await expect(section.getByTestId('diagnostics-prepare')).toHaveText('Prepare report');
    await shoot(app, section, 'after-settings-diagnostics-entry');
    await section.getByRole('button', { name: 'What the report includes' }).click();
    await expect(section.getByText(/library contents, documents, notes, chats/u)).toBeVisible();
    await shoot(app, section, 'after-settings-diagnostics-entry-details');

    // Step 1: prepare while the CLI reports signed out, so no provider is eligible.
    await section.getByTestId('diagnostics-prepare').click();
    const reviewHeading = section.getByRole('heading', { name: 'Report ready to review' });
    await expect(reviewHeading).toBeFocused();
    await expect(section.getByTestId('diagnostics-summary')).toContainText('(development build)');
    await section.getByRole('button', { name: 'Show the exact collected data' }).click();
    const packet = section.getByTestId('diagnostics-packet');
    await expect(packet).toContainText('"format": "interleaf-diagnostics/1"');
    const packetText = (await packet.textContent()) ?? '';
    expect(packetText).not.toContain(HOME_CANARY);
    expect(packetText).not.toContain(isolatedHome);
    await shoot(app, reviewHeading, 'after-settings-diagnostics-review-summary');
    await shoot(app, packet, 'after-settings-diagnostics-packet');

    await expect(section.getByTestId('diagnostics-no-provider')).toBeVisible();
    await expect(section.getByTestId('diagnostics-export')).toBeEnabled();
    await shoot(app, section.getByTestId('diagnostics-no-provider'), 'after-settings-diagnostics-no-provider');

    // Step 2: an expired handle recovers through Collect again across the real contextBridge.
    await expireShownReport(app);
    await stubSaveDialog(app, exportPath);
    await section.getByTestId('diagnostics-export').click();
    const alert = section.getByRole('alert');
    await expect(alert).toContainText('This diagnostics report has expired. Choose Collect again to prepare a new one.');
    await shoot(app, alert, 'after-settings-diagnostics-expired-error');
    expect(existsSync(exportPath)).toBe(false);

    // Step 3: sign the CLI in, refresh readiness the way the provider picker does, and collect again.
    claude.signIn();
    await app.window.evaluate(async () => {
      await Reflect.get(window, 'interleafAPI').ai.listProviders({ forceRefresh: true });
    });
    await section.getByTestId('diagnostics-recollect').click();
    await expect(section.getByTestId('diagnostics-provider')).toBeVisible();

    // Editing the description retires the review until the report is updated with main's sanitized copy.
    const draft = 'Imports fail. Contact me at reader@example.com, file /Users/reader/Books/private.pdf';
    await section.getByTestId('diagnostics-issue').fill(draft);
    await expect(section.getByTestId('diagnostics-export')).toHaveCount(0);
    await expect(section.getByTestId('diagnostics-prepare')).toHaveText('Update report');

    // The packet expires while the edit is pending: Collect again stays beside Update report and keeps the draft.
    await expireShownReport(app);
    await section.getByTestId('diagnostics-prepare').click();
    await expect(alert).toContainText('This diagnostics report has expired. Choose Collect again to prepare a new one.');
    await expect(section.getByTestId('diagnostics-issue')).toHaveValue(draft);
    await expect(section.getByTestId('diagnostics-export')).toHaveCount(0);
    await expect(section.getByTestId('diagnostics-recollect')).toBeVisible();
    await shoot(app, section.getByTestId('diagnostics-recollect'), 'after-settings-diagnostics-expired-after-edit');
    await section.getByTestId('diagnostics-recollect').click();
    await expect(section.getByTestId('diagnostics-shared-issue')).toContainText('Imports fail.');
    await expect(alert).toHaveCount(0);
    await expect(section.getByTestId('diagnostics-shared-issue')).toContainText('[email]');
    await expect(section.getByTestId('diagnostics-issue')).not.toHaveValue(/reader@example\.com/u);
    await section.getByRole('button', { name: 'Show the full report file' }).click();
    const report = section.getByTestId('diagnostics-report');
    await expect(report).toContainText('[email]');
    await expect(report).not.toContainText('reader@example.com');
    await expect(report).not.toContainText('/Users/reader');
    await expect(report).toContainText(`Interleaf ${APP_VERSION} (development)`);
    await shoot(app, report, 'after-settings-diagnostics-review');

    // Step 4: choosing a provider and model sends nothing; only Analyze starts the one CLI turn.
    await chooseListboxValue(section.getByTestId('diagnostics-provider'), 'claude');
    await chooseListboxValue(section.getByTestId('diagnostics-model'), 'claude-default');
    expect(claude.chatInvocations()).toHaveLength(0);
    const analyze = section.getByTestId('diagnostics-analyze');
    await expect(analyze).toHaveText('Analyze with Claude Code');
    await shoot(app, analyze, 'after-settings-diagnostics-analysis-ready');
    await analyze.click();

    const answer = section.getByTestId('diagnostics-analysis');
    await expect(answer.getByTestId('diagnostics-analysis-text')).toContainText('one import failure is counted');
    await expect(answer).not.toContainText('```bash');
    await expect(answer.locator('img, a')).toHaveCount(0);
    await expect(report).toContainText('one import failure is counted');
    await expect(report.locator('img')).toHaveCount(0);
    expect(await app.window.evaluate((flag) => typeof Reflect.get(window, flag), PWNED_FLAG)).toBe('undefined');
    await shoot(app, answer, 'after-settings-diagnostics-answer-visible');

    // Step 5: the ledger holds exactly one hardened chat turn carrying only the reviewed packet.
    const chats = claude.chatInvocations();
    expect(chats).toHaveLength(1);
    for (const arg of HARDENED_ARGS) expect(chats[0]).toContain(arg);
    expect(claude.invocations().filter((line) => line.startsWith('refused '))).toEqual([]);
    const prompts = claude.chatPrompts();
    expect(prompts).toHaveLength(1);
    const sent = prompts[0] ?? '';
    expect(sent).toContain('[email]');
    for (const forbidden of [HOME_CANARY, isolatedHome, 'reader@example.com', '/Users/reader']) {
      expect(sent).not.toContain(forbidden);
    }
    const reportText = (await report.textContent()) ?? '';

    // Step 6: the layout holds at narrow widths and 200% zoom without horizontal scrolling.
    await checkLayouts(app, modal, answer);

    // Step 7: a failed write keeps the report and recovers when another location is chosen.
    await stubSaveDialog(app, unwritablePath);
    await section.getByTestId('diagnostics-export').click();
    await expect(alert).toContainText('The diagnostics report could not be saved there. Choose another location.');
    expect(existsSync(unwritablePath)).toBe(false);
    await shoot(app, alert, 'after-settings-diagnostics-write-failure');

    await stubSaveDialog(app, exportPath);
    await section.getByTestId('diagnostics-export').click();
    await expect(section.getByTestId('diagnostics-notice')).toHaveText('Saved exported-report.md. Review it before sharing it with anyone.');
    const exported = readFileSync(exportPath, 'utf8');
    expect(exported).toBe(reportText);
    expect(exported).toContain(`Interleaf ${APP_VERSION} (development)`);
    expect(exported).not.toContain('Interleaf 44.7.0');
    expect(exported).not.toContain(HOME_CANARY);
    expect(claude.chatInvocations()).toHaveLength(1);
    await shoot(app, section.getByTestId('diagnostics-notice'), 'after-settings-diagnostics-exported');
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(claude.binDir, { recursive: true, force: true });
  }
});
