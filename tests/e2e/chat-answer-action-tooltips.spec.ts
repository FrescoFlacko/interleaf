import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, dismissOnboardingIfOpen, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

const COPY_HINT = 'Copy the full answer to the clipboard';
const SAVE_HINT = 'Save the answer as a note at your current location in this document';

/** Where the tooltip sits against the chat pane, the window and its button row. */
type TooltipGeometry = {
  readonly text: string;
  readonly opacity: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly paneLeft: number;
  readonly paneRight: number;
  readonly paneTop: number;
  readonly paneBottom: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly rowOverlap: boolean;
  readonly overflowsX: boolean;
};

function readTooltip(): TooltipGeometry | null {
  const tooltip = document.querySelector<HTMLElement>('[data-testid="chat-answer-action-tooltip"]');
  const pane = document.querySelector<HTMLElement>('.chat-design');
  const row = document.querySelector<HTMLElement>('[aria-label="Reader AI response"] .chat-design-actions');
  if (!tooltip || !pane || !row) return null;
  const box = tooltip.getBoundingClientRect();
  const paneBox = pane.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  return {
    text: tooltip.textContent,
    opacity: Number(getComputedStyle(tooltip).opacity),
    left: box.left,
    right: box.right,
    top: box.top,
    bottom: box.bottom,
    paneLeft: paneBox.left,
    paneRight: paneBox.right,
    paneTop: paneBox.top,
    paneBottom: paneBox.bottom,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rowOverlap: box.top < rowBox.bottom && rowBox.top < box.bottom,
    overflowsX: tooltip.scrollWidth > tooltip.clientWidth + 1,
  };
}

/** Screenshots go to the run's evidence directory when one is named. */
function evidencePath(name: string): string {
  const directory = process.env.INTERLEAF_E2E_EVIDENCE_DIR;
  return directory === undefined ? test.info().outputPath(name) : join(directory, name);
}

function expectContained(geometry: TooltipGeometry | null, label: string): void {
  expect(geometry, `${label}: tooltip is mounted`).not.toBeNull();
  const g = geometry!;
  expect(g.left, `${label}: inside the pane's left edge`).toBeGreaterThanOrEqual(g.paneLeft);
  expect(g.right, `${label}: inside the pane's right edge`).toBeLessThanOrEqual(g.paneRight);
  expect(g.top, `${label}: inside the pane's top`).toBeGreaterThanOrEqual(g.paneTop);
  expect(g.bottom, `${label}: inside the pane's bottom`).toBeLessThanOrEqual(g.paneBottom);
  expect(g.right, `${label}: inside the window`).toBeLessThanOrEqual(g.viewportWidth);
  expect(g.bottom, `${label}: inside the window`).toBeLessThanOrEqual(g.viewportHeight);
  expect(g.rowOverlap, `${label}: does not cover its own button row`).toBe(false);
  expect(g.overflowsX, `${label}: text wraps rather than clipping`).toBe(false);
}

/**
 * The icon-only Copy and Save note actions under a finished answer explain
 * themselves with the app's own tooltip, on hover and on keyboard focus, in the
 * real window. The answer comes from the deterministic local OpenRouter seam;
 * no paid provider call is made.
 */
test.describe('Chat answer action tooltips', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-tooltips-'));
    app = await launchInterleaf();
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'Chat_Tooltips_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Chat Tooltips Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic passage for answer action tooltip testing.']],
    }));
    await dismissOnboardingIfOpen(app);
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [imported] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(imported).toBeDefined();
    await app.window.getByTestId(`read-doc-${imported!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    await app.window.getByRole('tab', { name: 'Chat', exact: true }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');

    const composer = chat.getByLabel('Message Reader AI');
    await composer.fill('Summarize this document in Markdown.');
    await composer.press('Enter');
    await expect(chat.getByRole('button', { name: 'Copy answer' })).toBeVisible();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('explains Copy and Save note on hover and keyboard focus, then gets out of the way', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    const answer = chat.getByRole('article', { name: 'Reader AI response' });
    const copyButton = answer.getByRole('button', { name: 'Copy answer' });
    const saveButton = answer.getByRole('button', { name: 'Save answer as note' });
    const tooltip = app.window.getByTestId('chat-answer-action-tooltip');
    const rowBox = async (target: Locator) => target.evaluate((node) => JSON.stringify(node.closest('.chat-design-actions')!.getBoundingClientRect()));
    const articleBox = async () => answer.evaluate((node) => JSON.stringify(node.getBoundingClientRect()));

    // Named as before, described by the explanation, and no native tooltip.
    await expect(copyButton).toHaveAccessibleDescription(COPY_HINT);
    await expect(saveButton).toHaveAccessibleDescription(SAVE_HINT);
    await expect(copyButton).not.toHaveAttribute('title');
    await expect(saveButton).not.toHaveAttribute('title');

    const rowBefore = await rowBox(copyButton);
    const articleBefore = await articleBox();

    // Hover: appears after the short delay, contained, moving nothing.
    await copyButton.hover();
    await expect(tooltip).toHaveText(COPY_HINT);
    await expect.poll(async () => (await app.window.evaluate(readTooltip))?.opacity).toBe(1);
    expectContained(await app.window.evaluate(readTooltip), 'hover copy');
    expect(await rowBox(copyButton)).toBe(rowBefore);
    expect(await articleBox()).toBe(articleBefore);
    await app.window.screenshot({ path: evidencePath('01-hover-copy.png') });

    // The neighbour swaps in straight away.
    await saveButton.hover();
    await expect(tooltip).toHaveText(SAVE_HINT);
    expectContained(await app.window.evaluate(readTooltip), 'hover save');
    await app.window.screenshot({ path: evidencePath('02-hover-save.png') });

    // Leaving the row dismisses it.
    await chat.getByLabel('Message Reader AI').hover();
    await expect(tooltip).toHaveCount(0);

    // Keyboard: focus shows it at once, Tab moves it, Escape dismisses it.
    await copyButton.focus();
    await expect(tooltip).toHaveText(COPY_HINT, { timeout: 250 });
    await app.window.keyboard.press('Tab');
    await expect(saveButton).toBeFocused();
    await expect(tooltip).toHaveText(SAVE_HINT, { timeout: 250 });
    await app.window.screenshot({ path: evidencePath('03-keyboard-save.png') });
    await app.window.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await expect(saveButton).toBeFocused();
    await app.window.keyboard.press('Shift+Tab');
    await expect(tooltip).toHaveText(COPY_HINT, { timeout: 250 });
    await chat.getByLabel('Message Reader AI').focus();
    await expect(tooltip).toHaveCount(0);

    // A click dismisses it and still does the action.
    await saveButton.hover();
    await expect(tooltip).toHaveText(SAVE_HINT);
    await saveButton.click();
    await expect(tooltip).toHaveCount(0);
    await expect(chat.getByTestId('chat-toast')).toHaveText(/Note saved/u);
    expect(await rowBox(copyButton)).toBe(rowBefore);

    // A scroll of the thread takes a hover tooltip with it.
    await copyButton.hover();
    await expect(tooltip).toHaveText(COPY_HINT);
    await chat.getByTestId('chat-messages').evaluate((node) => { node.dispatchEvent(new Event('scroll')); });
    await expect(tooltip).toHaveCount(0);
  });

  test('stays inside a narrow chat pane', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    const answer = chat.getByRole('article', { name: 'Reader AI response' });
    const tooltip = app.window.getByTestId('chat-answer-action-tooltip');

    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await expect.poll(() => chat.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(320);

    for (const [name, hint, shot] of [
      ['Copy answer', COPY_HINT, '04-narrow-copy.png'],
      ['Save answer as note', SAVE_HINT, '05-narrow-save.png'],
    ] as const) {
      const button = answer.getByRole('button', { name });
      await button.focus();
      await expect(tooltip).toHaveText(hint);
      await expect.poll(async () => (await app.window.evaluate(readTooltip))?.opacity).toBe(1);
      expectContained(await app.window.evaluate(readTooltip), `narrow ${name}`);
      await app.window.screenshot({ path: evidencePath(shot) });
      await button.blur();
      await expect(tooltip).toHaveCount(0);
    }
  });
});
