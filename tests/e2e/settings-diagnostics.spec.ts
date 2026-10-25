import { expect, test, type Locator } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dismissOnboardingIfOpen, launchInterleaf, type AppHandle } from './helpers';
import { chooseListboxValue } from './listbox';
import { createDiagnosticsClaudeFixture } from './diagnostics-claude-fixture';

/**
 * Private diagnostics end to end in a real Electron window: collect, review,
 * the no-provider state, expired and write-failure recovery, analysis through
 * the real Claude Code CLI adapter (an offline `claude` fixture on the
 * launch PATH, never the network or a paid model) and export through the
 * native save dialog.
 *
 * Set `INTERLEAF_DIAGNOSTICS_SCREENSHOTS` to a directory to keep the screens.
 */

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
  await app.window.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' });
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
    await shoot(app, section, 'after-settings-diagnostics-entry');

    // Step 1: collect while the CLI reports signed out, so no provider is eligible.
    const runBtn = section.getByTestId('diagnostics-run');
    await runBtn.click();
    const packet = section.getByTestId('diagnostics-packet');
    await expect(packet).toContainText('"format": "interleaf-diagnostics/1"');
    const packetText = (await packet.textContent()) ?? '';
    expect(packetText).not.toContain(HOME_CANARY);
    expect(packetText).not.toContain(isolatedHome);
    await shoot(app, packet, 'after-settings-diagnostics-packet');

    await section.getByTestId('diagnostics-review').click();
    await expect(section.getByTestId('diagnostics-no-provider')).toBeVisible();
    await shoot(app, section.getByTestId('diagnostics-no-provider'), 'after-settings-diagnostics-no-provider');

    // Step 2: an expired handle recovers through "Run diagnostics again" across the real contextBridge.
    await app.window.evaluate(async () => {
      const api = Reflect.get(window, 'interleafAPI');
      const replacement = await api.diagnostics.collect();
      await api.diagnostics.discard(replacement.handle);
    });
    await stubSaveDialog(app, exportPath);
    await section.getByTestId('diagnostics-export').click();
    const alert = section.getByRole('alert');
    await expect(alert).toContainText('This diagnostics report has expired. Run diagnostics again.');
    await shoot(app, alert, 'after-settings-diagnostics-expired-error');
    expect(existsSync(exportPath)).toBe(false);

    // Step 3: sign the CLI in, refresh readiness the way the provider picker does, and run again.
    claude.signIn();
    await app.window.evaluate(async () => {
      await Reflect.get(window, 'interleafAPI').ai.listProviders({ forceRefresh: true });
    });
    await runBtn.click();
    await expect(section.getByTestId('diagnostics-packet')).toBeVisible();

    await section.getByTestId('diagnostics-issue').fill('Imports fail. Contact me at reader@example.com, file /Users/reader/Books/private.pdf');
    await section.getByTestId('diagnostics-review').click();
    const report = section.getByTestId('diagnostics-report');
    await expect(report).toContainText('[email]');
    await expect(report).not.toContainText('reader@example.com');
    await expect(report).not.toContainText('/Users/reader');
    await expect(report).toContainText('Interleaf 0.13.0 (development)');
    await shoot(app, report, 'after-settings-diagnostics-review');

    // Step 4: choosing a provider and model sends nothing; only Analyze starts the one CLI turn.
    await chooseListboxValue(section.getByTestId('diagnostics-provider'), 'claude');
    await chooseListboxValue(section.getByTestId('diagnostics-model'), 'claude-default');
    expect(claude.chatInvocations()).toHaveLength(0);
    const analyze = section.getByTestId('diagnostics-analyze');
    await expect(analyze).toHaveText('Analyze with Claude Code');
    await analyze.click();

    await expect(report).toContainText('one import failure is counted');
    await expect(report).not.toContainText('```bash');
    await expect(report.locator('img')).toHaveCount(0);
    expect(await app.window.evaluate((flag) => typeof Reflect.get(window, flag), PWNED_FLAG)).toBe('undefined');

    await report.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shoot(app, report, 'after-settings-diagnostics-answer-visible');

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

    // Step 6: a failed write keeps the report and recovers when another location is chosen.
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
    expect(exported).toContain('Interleaf 0.13.0 (development)');
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
