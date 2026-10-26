import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/** The reference panel width; `PANEL_BOUNDS.right` is 280–560. */
const REFERENCE_WIDTH = 480;
/** Every companion tab insets its content by exactly one 16 px gutter. */
const GUTTER = 16;

/**
 * The leading header container of each companion surface. Its content box —
 * border box inset by its own padding — is where that tab's visible content
 * starts, whether the inset comes from the shared panel wrapper (Search) or
 * from the tab's own padding (AI Chat, Annotations, Agent).
 */
const PROBES = {
  chat: '.chat-design-header',
  search: '[data-testid="search-panel"]',
  annotations: '[data-testid="annotation-browser"] > div:first-child',
  agentTask: 'section[aria-labelledby="agent-composer-heading"] > div:first-child',
  agentRun: 'section[aria-labelledby="agent-active-session-heading"] > div:first-child',
} as const;

/**
 * The Agent tab must sit on the same left/right gutter as its companion tabs.
 * It regressed by receiving the shared wrapper's `p-4` *and* the redesigned
 * views' own `px-4`, which doubled its inset to 32 px while AI Chat, Search and
 * Annotations stayed at 16 px.
 */
test.describe('Companion panel content margins', () => {
  let app: AppHandle;
  let workspace: string;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
    workspace = mkdtempSync(join(tmpdir(), 'interleaf-agent-margins-'));
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function openDocument(): Promise<void> {
    const pdfPath = join(workspace, 'agent-margins.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Attention Is All You Need',
      author: 'Interleaf',
      pageLines: [['Scaled dot-product attention and multi-head attention.']],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture document was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
  }

  /** Keyboard resize: End goes to the 560 px maximum, each ArrowRight removes 16 px. */
  async function setPanelWidth(width: number): Promise<void> {
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    const steps = (560 - width) / 16;
    for (let step = 0; step < steps; step += 1) await app.window.keyboard.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(width));
    await app.window.waitForTimeout(350);
  }

  /** Distance from each panel edge to the first column of the probe's content. */
  async function gutters(probe: string): Promise<{ left: number; right: number }> {
    return app.window.evaluate((selector) => {
      const panel = document.querySelector('[data-testid="companion-panel"]');
      const element = document.querySelector(selector);
      if (panel === null || element === null) throw new Error(`No element matched ${selector}`);
      const panelBox = panel.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(box.left + Number.parseFloat(style.paddingLeft) - panelBox.left),
        right: Math.round(panelBox.right - (box.right - Number.parseFloat(style.paddingRight))),
      };
    }, probe);
  }

  /**
   * How far a child sits inside the content box of its scrolling ancestor,
   * with the space the platform draws its scrollbar in excluded.
   *
   * The gutter belongs to the scrolling region; a classic (non-overlay)
   * scrollbar is drawn by the OS inside that region and narrows every child's
   * border box by its width. Discounting exactly that width keeps the check
   * strict: any inset the feed adds of its own is still a failure.
   */
  async function insetWithinScroller(
    scroller: string,
    child: string
  ): Promise<{ left: number; right: number }> {
    return app.window.evaluate(([scrollerSelector, childSelector]) => {
      const region = document.querySelector(scrollerSelector);
      const element = document.querySelector(childSelector);
      if (region === null || element === null) throw new Error('No element matched the probe');
      const style = getComputedStyle(region);
      const regionBox = region.getBoundingClientRect();
      const scrollbar =
        region.getBoundingClientRect().width -
        Number.parseFloat(style.borderLeftWidth) -
        Number.parseFloat(style.borderRightWidth) -
        region.clientWidth;
      const box = element.getBoundingClientRect();
      return {
        left: Math.round(box.left - (regionBox.left + Number.parseFloat(style.paddingLeft))),
        right: Math.round(
          regionBox.right - Number.parseFloat(style.paddingRight) - scrollbar - box.right
        ),
      };
    }, [scroller, child] as const);
  }

  /**
   * Switches tabs and waits for the surface to be laid out *and* for the tab
   * bar to finish saying so. The tab buttons carry `transition-colors`, so a
   * screenshot taken on the click still shows the accent underline on the
   * previous tab while the new tab's content is already painted — accurate
   * state, misleading evidence. Waiting on `aria-selected` and then on the tab
   * bar having no running transitions observes the real end of the animation
   * instead of guessing a duration.
   */
  async function openTab(name: string, probe: string): Promise<void> {
    const tab = app.window.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await app.window.locator(probe).first().waitFor({ state: 'visible' });
    await app.window.waitForFunction(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .every((button) => button.getAnimations().length === 0));
  }

  test('the Agent new-task view shares the 16 px gutter of the other companion tabs', async () => {
    await openDocument();
    await openTab('Agent', PROBES.agentTask);
    await expect(app.window.getByLabel('Task description')).toBeVisible();
    await setPanelWidth(REFERENCE_WIDTH);

    await openTab('Chat', PROBES.chat);
    const chat = await gutters(PROBES.chat);
    await openTab('Search', PROBES.search);
    const search = await gutters(PROBES.search);
    await openTab('Annotations', PROBES.annotations);
    const annotations = await gutters(PROBES.annotations);

    // The comparison tabs establish the shared gutter empirically rather than
    // the test asserting only a constant the Agent tab might drift away from.
    expect(chat).toEqual({ left: GUTTER, right: GUTTER });
    expect(search).toEqual({ left: GUTTER, right: GUTTER });
    expect(annotations).toEqual({ left: GUTTER, right: GUTTER });

    await openTab('Agent', PROBES.agentTask);
    await expect(app.window.getByLabel('Task description')).toBeVisible();
    expect(await gutters(PROBES.agentTask)).toEqual(chat);

    // The gutter is a fixed inset, not a proportion of the panel width.
    await setPanelWidth(280);
    expect(await gutters(PROBES.agentTask)).toEqual({ left: GUTTER, right: GUTTER });
  });

  test('the Agent run view keeps that gutter for its header, feed and pinned resume', async () => {
    await openDocument();
    await openTab('Agent', PROBES.agentTask);
    await expect(app.window.getByLabel('Task description')).toBeVisible();
    await setPanelWidth(REFERENCE_WIDTH);

    await selectFakeAgentForTest(app);
    await stubOpenDialog(app, [workspace]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await expect(app.window.getByTestId('agent-working-directory')).not.toHaveText('No folder selected');
    await app.window.getByLabel('Task description').fill('Summarise the attached excerpt.');
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByTestId('agent-session-status'))
      .toHaveText('Session completed.', { timeout: 20_000 });

    expect(await gutters(PROBES.agentRun)).toEqual({ left: GUTTER, right: GUTTER });

    // The scrolling feed and the pinned resume bar are separate boxes, so each
    // has to hold the gutter on its own.
    // The feed is the scrolling region, so the gutter is measured on the
    // region that owns the padding and the list is required to fill it: the
    // only thing allowed between the list and the panel edge is that gutter
    // and whatever width the platform gives its own scrollbar.
    const feed = await gutters('[data-testid="agent-activity-scroll"]');
    expect(feed).toEqual({ left: GUTTER, right: GUTTER });
    expect(
      await insetWithinScroller('[data-testid="agent-activity-scroll"]', '[data-testid="agent-activity-list"]')
    ).toEqual({ left: 0, right: 0 });
    const resume = await gutters('[data-testid="agent-resume-section"]');
    expect(resume).toEqual({ left: GUTTER, right: GUTTER });

    await setPanelWidth(280);
    expect(await gutters(PROBES.agentRun)).toEqual({ left: GUTTER, right: GUTTER });
  });
});
