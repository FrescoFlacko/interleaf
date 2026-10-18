import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * The Chat/Agent text-size preference, measured in a real browser.
 *
 * The preference is only worth having if it reaches the words a reader
 * actually reads — prose, headings, lists, tables, code, and the agent's own
 * reports — and only safe if it leaves the chrome alone, because tabs, icon
 * buttons and hit targets are sized for aiming rather than for reading. Class
 * names cannot show either half of that: the sizes come from Tailwind
 * utilities, from unlayered CSS, and from a custom property multiplied
 * together, so the evidence here is `getComputedStyle` at 100% and at the
 * 150% maximum, from the running application.
 *
 * The last test is the other half of the bargain: 150% text must still lay out
 * at the narrowest supported panel and at 200% browser zoom, rather than
 * pushing the panel sideways.
 */

/** The preference's maximum, and the interesting end of its range. */
const LARGEST = 1.5;

/** The supported minimum width of the companion column. */
const MINIMUM_WIDTH = 280;

/** How far a scaled size may sit from the exact multiple, in CSS pixels. */
const ROUNDING = 0.51;

type Probe = { readonly name: string; readonly selector: string };

/** Readable Chat content: prose, a heading, a list, a table and code. */
const CHAT_READABLE: readonly Probe[] = [
  { name: 'answer paragraph', selector: '[data-testid="chat-messages"] .chat-design-assistant p' },
  { name: 'answer heading', selector: '[data-testid="chat-messages"] .chat-design-assistant h3' },
  { name: 'answer list item', selector: '[data-testid="chat-messages"] .chat-design-assistant li' },
  { name: 'answer quote', selector: '[data-testid="chat-messages"] .chat-design-assistant blockquote' },
  { name: 'answer code block', selector: '[data-testid="chat-messages"] .chat-design-assistant pre' },
  { name: 'prompt paragraph', selector: '[data-testid="chat-messages"] .chat-design-user p' },
  { name: 'prompt heading', selector: '[data-testid="chat-messages"] .chat-design-user h3' },
  { name: 'prompt table cell', selector: '[data-testid="chat-messages"] .chat-design-user td' },
];

/** Chat chrome: aimed at rather than read, and therefore fixed. */
const CHAT_FIXED: readonly Probe[] = [
  { name: 'model picker', selector: '[data-testid="chat-model-picker"]' },
  { name: 'copy answer button', selector: '[data-testid="copy-chat-answer"]' },
  { name: 'companion tab', selector: '[role="tab"]' },
];

/** Readable Agent content: the task, the feed, its output, and the report. */
const AGENT_READABLE: readonly Probe[] = [
  { name: 'task summary', selector: '[data-testid="agent-active-session-title"]' },
  { name: 'final report', selector: '[data-testid="agent-final-report"] p' },
  { name: 'process output', selector: '[data-testid^="activity-log-"]' },
  { name: 'changed files', selector: '[data-testid="agent-review-files"] li' },
  { name: 'test outcomes', selector: '[data-testid="agent-review-tests"] li' },
  { name: 'review diff', selector: '[data-testid="agent-environment-diff"]' },
];

/** Agent chrome, which the preference must leave alone. */
const AGENT_FIXED: readonly Probe[] = [
  { name: 'status badge', selector: '[data-testid="agent-session-status-badge"]' },
  { name: 'activity filter', selector: '[data-testid="agent-activity-filter"]' },
  { name: 'activity count', selector: '[data-testid="agent-activity-count"]' },
];

test.describe('Chat and Agent text size', () => {
  let app: AppHandle;
  let workspace: string;

  test.beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'interleaf-companion-text-'));
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Chat and Agent want different applications: Chat needs a configured
   * provider and nothing else, and the Agent tests need the deterministic
   * `fake` profile, which only exists when the test seam is enabled.
   */
  async function launch(options?: { readonly testSeam?: boolean }): Promise<void> {
    app = await launchInterleaf(options?.testSeam === true ? { testSeam: true } : {});
  }

  async function openDocument(): Promise<void> {
    const pdfPath = join(workspace, 'companion-text.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Attention Is All You Need',
      author: 'Interleaf',
      pageLines: [['Scaled dot-product attention and multi-head attention.']],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    await readImportedDocument();
  }

  async function readImportedDocument(): Promise<void> {
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture document was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
  }

  /** The scale the companion panel is currently applying. */
  async function panelScale(): Promise<string> {
    return app.window.getByTestId('companion-panel')
      .evaluate((panel) => panel.style.getPropertyValue('--companion-text-scale'));
  }

  /** Sets the preference through its only control, Settings → Appearance. */
  async function setTextSize(target: number): Promise<void> {
    await app.window.getByTestId('open-settings').click();
    const modal = app.window.getByTestId('ai-providers-settings-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Appearance' }).click();
    await modal.getByTestId('settings-companion-text-size').fill(String(target));
    await expect(modal.getByText('Settings saved on this device.')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect.poll(panelScale).toBe(String(target));
  }

  /**
   * Stores the preference and reloads, which reads it back as a relaunch
   * would. For test-seam launches only: there Settings cannot load, because
   * the fake provider's status fails the renderer's provider-id schema.
   */
  async function storeTextSize(target: number): Promise<void> {
    await app.window.evaluate(async (textSize) => {
      const api = window.interleafAPI;
      const current = await api.settings.get();
      await api.settings.update({ ...current, companion: { ...current.companion, textSize } });
    }, target);
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');
    await expect.poll(panelScale).toBe(String(target));
  }

  /** Rendered font sizes, in CSS pixels, from the running window. */
  async function fontSizes(probes: readonly Probe[]): Promise<Record<string, number>> {
    return app.window.evaluate((list: readonly Probe[]) => {
      const sizes: Record<string, number> = {};
      for (const probe of list) {
        const element = document.querySelector<HTMLElement>(probe.selector);
        if (element === null) throw new Error(`No ${probe.name} matched ${probe.selector}`);
        sizes[probe.name] = Number.parseFloat(getComputedStyle(element).fontSize);
      }
      return sizes;
    }, probes);
  }

  /** Every readable size multiplied, every fixed size untouched. */
  function expectScaled(
    before: Record<string, number>,
    after: Record<string, number>,
    scale: number,
    label: string,
  ): void {
    for (const [name, size] of Object.entries(before)) {
      expect(size, `${label}: "${name}" must have a real size at 100%`).toBeGreaterThan(0);
      expect(after[name], `${label}: "${name}" did not follow the text size preference`)
        .toBeCloseTo(size * scale, 0);
      expect(Math.abs((after[name] ?? 0) - size * scale), `${label}: "${name}" is off its scaled size`)
        .toBeLessThanOrEqual(ROUNDING);
    }
  }

  function expectUnchanged(
    before: Record<string, number>,
    after: Record<string, number>,
    label: string,
  ): void {
    for (const [name, size] of Object.entries(before)) {
      expect(after[name], `${label}: "${name}" is chrome and must not resize`).toBe(size);
    }
  }

  test('scales the words in a Chat transcript and leaves its controls alone', async () => {
    await launch();
    await configureOpenRouterTestSeam(app);
    await openDocument();

    await app.window.getByRole('tab', { name: 'Chat', exact: true }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(chat.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    // A prompt that is itself readable content: prose, a heading and a table.
    // The word "markdown" also selects the seam's formatted answer, which
    // carries the heading, list, quote and code block measured below.
    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill([
      '### Prompt heading',
      '',
      'Summarise the attention markdown table below.',
      '',
      '| Head | Role |',
      '| --- | --- |',
      '| 1 | local |',
      '| 2 | global |',
      '',
    ].join('\n'));
    await composer.press('Enter');
    await expect(chat.getByRole('article').filter({ hasText: 'Reader AI' })
      .getByRole('heading', { name: 'Grounded Markdown' })).toBeVisible({ timeout: 20_000 });
    await expect(app.window.locator('[data-testid="chat-messages"] .chat-design-user td').first()).toBeVisible();

    const readableBefore = await fontSizes(CHAT_READABLE);
    const fixedBefore = await fontSizes(CHAT_FIXED);
    // The reader's default is untouched until they ask for something else.
    expect(await panelScale()).toBe('1');

    await setTextSize(LARGEST);
    const readableAfter = await fontSizes(CHAT_READABLE);
    const fixedAfter = await fontSizes(CHAT_FIXED);

    expectScaled(readableBefore, readableAfter, LARGEST, 'chat at 150%');
    expectUnchanged(fixedBefore, fixedAfter, 'chat at 150%');
  });

  /** A repository, so the run produces a review with changed files and a diff. */
  function fixtureRepository(name: string): string {
    const repository = join(workspace, name);
    execFileSync('git', ['init', '--quiet', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Interleaf Fixture']);
    writeFileSync(join(repository, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'fixture']);
    return repository;
  }

  /**
   * Runs the deterministic fake agent on the fixture repository and opens its
   * report. The report opens collapsed, and its diff behind a control.
   */
  async function runAgentAndShowReview(repository: string): Promise<void> {
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    await selectFakeAgentForTest(app);
    await stubOpenDialog(app, [repository]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await app.window.getByLabel('Task description')
      .fill('Summarise the attention excerpt and record the result.');
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 30_000 });
    await app.window.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(app.window.getByTestId('agent-review-files')).toBeVisible({ timeout: 10_000 });
    await expect(app.window.getByTestId('agent-review-tests')).toContainText('passed');
    await app.window.getByRole('button', { name: 'View Diff' }).click();
    await expect(app.window.getByTestId('agent-environment-diff')).toBeVisible({ timeout: 10_000 });
  }

  test('scales the Agent task, feed, output and report and leaves its controls alone', async () => {
    await launch({ testSeam: true });
    await openDocument();
    await runAgentAndShowReview(fixtureRepository('repo-100'));
    const readableBefore = await fontSizes(AGENT_READABLE);
    const fixedBefore = await fontSizes(AGENT_FIXED);

    // The reload closes the document and the report, and the fake agent is
    // deterministic, so the same task run again is the same content at 150%.
    await storeTextSize(LARGEST);
    await readImportedDocument();
    // A second repository: the first session still holds its own.
    await runAgentAndShowReview(fixtureRepository('repo-150'));
    const readableAfter = await fontSizes(AGENT_READABLE);
    const fixedAfter = await fontSizes(AGENT_FIXED);

    expectScaled(readableBefore, readableAfter, LARGEST, 'agent at 150%');
    expectUnchanged(fixedBefore, fixedAfter, 'agent at 150%');
  });

  test('still reflows at 150% in the narrowest panel and at 200% browser zoom', async () => {
    await launch();
    await configureOpenRouterTestSeam(app);
    await openDocument();

    await app.window.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    await app.window.getByRole('button', { name: 'New chat' }).click();
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');

    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill('Explain the markdown structure of this excerpt.');
    await composer.press('Enter');
    await expect(app.window.locator('[data-testid="chat-messages"] .chat-design-assistant pre'))
      .toBeVisible({ timeout: 20_000 });

    await setTextSize(LARGEST);

    // The narrowest supported panel, with the largest text in it.
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(MINIMUM_WIDTH));
    await app.window.waitForTimeout(350);
    const narrow = await measureContainment();
    expectContained(narrow, `${String(MINIMUM_WIDTH)} px panel at 150% text`);

    // 200% browser zoom on top of it: Chat moves into the compact drawer.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (!main) throw new Error('Main BrowserWindow was not found.');
      main.setSize(960, 640);
      main.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);

    const drawerToggle = app.window.getByTestId('toggle-right-panel');
    if (await drawerToggle.isVisible()) await drawerToggle.click();
    const drawer = app.window.getByTestId('compact-drawer-right');
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect(drawer).toBeInViewport({ ratio: 0.9 });
    await expect(drawer.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    const zoomed = await measureContainment();
    expectContained(zoomed, '200% zoom at 150% text');
    // The words really are larger here, not reset by the zoom change.
    expect(zoomed.paragraphFontSize, 'the preference must survive a zoom change')
      .toBeGreaterThan(14 * LARGEST - ROUNDING);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.0);
    });
  });

  type Containment = {
    readonly innerWidth: number;
    readonly bodyScrollWidth: number;
    readonly chatOverflowX: number;
    readonly codeOverflowX: number;
    readonly transcriptRight: number;
    readonly surfaceRight: number;
    readonly paragraphFontSize: number;
    readonly offenders: readonly string[];
  };

  /** Everything that would show as sideways scrolling or a clipped word. */
  async function measureContainment(): Promise<Containment> {
    return app.window.evaluate(() => {
      const transcript = document.querySelector<HTMLElement>('[data-testid="chat-messages"]');
      if (transcript === null) throw new Error('The transcript was not mounted.');
      const surface = transcript.closest<HTMLElement>('[data-testid="compact-drawer-right"], [data-testid="companion-panel"]')
        ?? transcript;
      const code = transcript.querySelector<HTMLElement>('pre');
      const paragraph = transcript.querySelector<HTMLElement>('.chat-design-assistant p');
      const limit = surface.getBoundingClientRect().right;
      return {
        innerWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
        chatOverflowX: transcript.scrollWidth - transcript.clientWidth,
        codeOverflowX: code === null ? 0 : code.scrollWidth - code.clientWidth,
        transcriptRight: transcript.getBoundingClientRect().right,
        surfaceRight: limit,
        paragraphFontSize: paragraph === null ? 0 : Number.parseFloat(getComputedStyle(paragraph).fontSize),
        offenders: [...transcript.querySelectorAll<HTMLElement>('*')]
          .filter((element) => element.checkVisibility() && element.getBoundingClientRect().right > limit + 1)
          .slice(0, 6)
          .map((element) => `${element.tagName.toLowerCase()}.${element.className.split(' ')[0] ?? ''}`),
      };
    });
  }

  function expectContained(metrics: Containment, label: string): void {
    expect(metrics.offenders, `${label}: content crosses the panel's right edge`).toEqual([]);
    expect(metrics.bodyScrollWidth, `${label}: the window scrolls sideways`)
      .toBeLessThanOrEqual(metrics.innerWidth + 1);
    expect(metrics.chatOverflowX, `${label}: the transcript scrolls sideways`).toBeLessThanOrEqual(1);
    expect(metrics.codeOverflowX, `${label}: a code block scrolls the transcript sideways`).toBeLessThanOrEqual(1);
    expect(metrics.transcriptRight, `${label}: the transcript is wider than its surface`)
      .toBeLessThanOrEqual(metrics.surfaceRight + 1);
    expect(metrics.paragraphFontSize, `${label}: no readable paragraph was measured`).toBeGreaterThan(0);
  }
});
