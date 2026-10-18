import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, dismissOnboardingIfOpen, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Real-window checks for two AI Chat changes that only a browser can settle:
 * a saved-note confirmation must not move anything the reader is pointing at,
 * and the context-window wheel must sit beside Send without colliding with it
 * at the narrowest supported panel or at 200% zoom.
 *
 * No paid provider call is made. The OpenRouter transport is answered by the
 * deterministic local seam, so the figures the popover prints are main's own
 * accounting for a request that really was packed and sent.
 */

/** Geometry of the composer's trailing control group. */
function measureComposer(): {
  readonly sharedParent: boolean;
  readonly gapToSend: number;
  readonly overlapWithSend: number;
  readonly sameRow: boolean;
  readonly meterWidth: number;
  readonly meterHeight: number;
  readonly sendRight: number;
  readonly formRight: number;
  readonly formOverflowX: number;
  readonly bodyOverflowX: number;
  readonly sendDisabled: boolean;
} {
  const meter = document.querySelector<HTMLElement>('[data-testid="chat-context-budget"]');
  const send = document.querySelector<HTMLButtonElement>('[data-testid="send-chat-button"]');
  const form = document.querySelector<HTMLFormElement>('form:has(#chat-composer)');
  if (!meter || !send || !form) throw new Error('Chat composer controls were not mounted.');
  const meterBox = meter.getBoundingClientRect();
  const sendBox = send.getBoundingClientRect();
  const formBox = form.getBoundingClientRect();
  return {
    sharedParent: meter.parentElement === send.parentElement,
    gapToSend: sendBox.left - meterBox.right,
    overlapWithSend: Math.max(0, meterBox.right - sendBox.left),
    sameRow: meterBox.top < sendBox.bottom && sendBox.top < meterBox.bottom,
    meterWidth: meterBox.width,
    meterHeight: meterBox.height,
    sendRight: sendBox.right,
    formRight: formBox.right,
    formOverflowX: form.scrollWidth - form.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    sendDisabled: send.disabled,
  };
}

test.describe('AI chat polish: saved-note toast and composer context wheel', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let documentId: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-polish-'));
    app = await launchInterleaf();
    // The real OpenRouter boundary, answered locally. Nothing is billed.
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'Chat_Polish_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Chat Polish Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic passage for chat confirmation and layout testing.']],
    }));
    await dismissOnboardingIfOpen(app);
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [imported] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(imported).toBeDefined();
    documentId = imported!.id;
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    await app.window.getByRole('tab', { name: 'Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();

    // Bind the session to the intercepted OpenRouter boundary explicitly, so
    // the answer comes from the deterministic seam rather than from whichever
    // CLI provider happens to be installed on the machine running this suite.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(chat.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    const composer = chat.getByLabel('Message Reader AI');
    await composer.fill('Summarize this document in Markdown.');
    await composer.press('Enter');
    await expect.poll(async () => {
      const sessions = await app.window.evaluate(async (id) => window.interleafAPI.chat.listSessions(id), documentId);
      const session = sessions[0];
      if (!session) return null;
      const messages = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), session.id);
      return messages.find((message) => message.role === 'assistant')?.status ?? null;
    }).toBe('complete');
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('confirms a saved note in a toast that moves nothing and clears itself', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    const answer = chat.getByRole('article').filter({ hasText: 'Reader AI' });
    await expect(answer).toBeVisible();

    const readGeometry = async () => app.window.evaluate(() => {
      const article = document.querySelector<HTMLElement>('[aria-label="Reader AI response"]');
      const form = document.querySelector<HTMLFormElement>('form:has(#chat-composer)');
      const messages = document.querySelector<HTMLElement>('[data-testid="chat-messages"]');
      const actions = article?.querySelector<HTMLElement>('.chat-design-actions');
      if (!article || !form || !messages || !actions) throw new Error('Chat answer and composer were not mounted.');
      return {
        article: JSON.stringify(article.getBoundingClientRect()),
        form: JSON.stringify(form.getBoundingClientRect()),
        actions: JSON.stringify(actions.getBoundingClientRect()),
        formTop: form.getBoundingClientRect().top,
        messagesScrollHeight: messages.scrollHeight,
      };
    });

    const before = await readGeometry();
    await answer.getByRole('button', { name: 'Save answer as note' }).click();

    const toast = chat.getByTestId('chat-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(/Note saved/u);
    await expect(chat.getByTestId('chat-toast-announcement')).toHaveText('Note saved');

    // The confirmation follows a real write: the note is in the database, and
    // the answer's Markdown source was stored, not the rendered text.
    const notes = await app.window.evaluate(async (id) =>
      (await window.interleafAPI.annotations.list(id)).filter((item) => item.type === 'note'), documentId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('**formatted**');

    const after = await readGeometry();
    const toastBox = await app.window.evaluate(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="chat-toast"]');
      if (!element) throw new Error('Toast was not mounted.');
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, left: box.left, width: box.width };
    });

    // Confirming an action must not move the control the reader just used, nor
    // the answer they are reading, nor the composer they are about to type in.
    expect(after.article).toBe(before.article);
    expect(after.actions).toBe(before.actions);
    expect(after.form).toBe(before.form);
    expect(after.messagesScrollHeight).toBe(before.messagesScrollHeight);
    // It floats above the composer rather than inside it, and stays on screen.
    expect(toastBox.bottom).toBeLessThanOrEqual(after.formTop + 1);
    expect(toastBox.left).toBeGreaterThanOrEqual(-1);
    expect(toastBox.width).toBeGreaterThan(0);

    // Floating over the action row is only acceptable while the row stays
    // usable: a success notice has nothing to click, so the pointer passes
    // through it to whatever it happens to cover.
    const passesThrough = await app.window.evaluate(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="chat-toast"]');
      if (!element) throw new Error('Toast was not mounted.');
      const box = element.getBoundingClientRect();
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        pointerEvents: getComputedStyle(element).pointerEvents,
        hitsToast: element.contains(under),
      };
    });
    expect(passesThrough.pointerEvents).toBe('none');
    expect(passesThrough.hitsToast).toBe(false);
    // Proof rather than inference: the button it covers still takes the click,
    // the second save is written too, and the notice restarts rather than
    // stacking a second panel.
    await answer.getByRole('button', { name: 'Save answer as note' }).click();
    await expect(chat.getByTestId('chat-toast')).toHaveCount(1);
    await expect(chat.getByTestId('chat-toast')).toHaveText(/Note saved/u);
    await expect.poll(async () => app.window.evaluate(async (id) =>
      (await window.interleafAPI.annotations.list(id)).filter((item) => item.type === 'note').length,
    documentId)).toBe(2);

    // It is transient: nothing has to be dismissed by hand, and the polite
    // region empties so a later save is announced as a new message.
    await expect(toast).toHaveCount(0, { timeout: 15_000 });
    await expect(chat.getByTestId('chat-toast-announcement')).toHaveText('');
    expect((await readGeometry()).form).toBe(before.form);
  });

  test('puts the context wheel in the lower composer controls and opens its popover from pointer and keyboard', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    const meter = chat.getByTestId('chat-context-budget');
    await expect(meter).toBeVisible();

    const layout = await app.window.evaluate(measureComposer);
    // Under the input, last of the per-session tools in the one tool row, and
    // kept apart from Send, which is pushed to the row's end because it
    // answers the draft rather than the conversation the wheel reports on.
    expect(layout.sharedParent).toBe(true);
    expect(layout.sameRow).toBe(true);
    expect(layout.overlapWithSend).toBe(0);
    expect(layout.gapToSend).toBeGreaterThanOrEqual(4);
    // Separate control groups under the input, never one strip beside Send;
    // the exact pixel gap varies with panel width as the menus give way.
    // WCAG 2.2 SC 2.5.8: the wheel is a control, so it is at least 24x24.
    expect(layout.meterWidth).toBeGreaterThanOrEqual(24);
    expect(layout.meterHeight).toBeGreaterThanOrEqual(24);
    expect(layout.sendRight).toBeLessThanOrEqual(layout.formRight + 1);
    expect(layout.formOverflowX).toBeLessThanOrEqual(1);
    // With an empty draft Send is disabled; that changes nothing about where
    // the wheel sits or how much room it has.
    expect(layout.sendDisabled).toBe(true);

    const composer = chat.getByLabel('Message Reader AI');
    await composer.fill('A draft that arms Send.');
    const armed = await app.window.evaluate(measureComposer);
    expect(armed.sendDisabled).toBe(false);
    expect(armed.gapToSend).toBeCloseTo(layout.gapToSend, 1);
    expect(armed.overlapWithSend).toBe(0);
    await composer.fill('');

    // What the popover says is main's accounting, not the panel's arithmetic.
    const budget = await app.window.evaluate(async (id) => {
      const sessions = await window.interleafAPI.chat.listSessions(id);
      return window.interleafAPI.chat.getContextBudget(sessions[0]!.id);
    }, documentId);
    expect(budget).not.toBeNull();
    expect(budget!.usedTokens).toBeGreaterThan(0);

    await expect(meter).toHaveAttribute('aria-expanded', 'false');
    await expect(meter).toHaveAccessibleName(/Context window: (\d+% used, )?last request used/u);
    await meter.click();
    const popover = app.window.getByTestId('chat-context-budget-popover');
    await expect(popover).toBeVisible();
    await expect(meter).toHaveAttribute('aria-expanded', 'true');
    expect(await meter.getAttribute('aria-controls')).toBe(await popover.getAttribute('id'));
    await expect(popover).toHaveAttribute('role', 'dialog');
    await expect(popover).toBeFocused();

    await expect(popover.getByTestId('chat-context-budget-estimate-label')).toContainText('Estimated tokens');
    const aggregate = popover.getByTestId('chat-context-budget-tokens');
    await expect(aggregate).toContainText(budget!.usedTokens.toLocaleString('en-US'));
    const total = budget!.totalTokens;
    if (total === null) {
      await expect(popover.getByTestId('chat-context-budget-unknown-total')).toBeVisible();
      await expect(meter).toHaveAttribute('data-budget-total', 'unavailable');
    } else {
      await expect(aggregate).toContainText(total.toLocaleString('en-US'));
      await expect(meter).toHaveAttribute('data-budget-total', 'known');
    }
    // The removed prose is gone; the itemised figures stay.
    await expect(popover.getByTestId('chat-context-budget-summary')).toHaveCount(0);
    await expect(popover).not.toContainText('rather than the prompt you are writing');
    await expect(popover.getByTestId('chat-context-budget-breakdown')).toBeVisible();

    const placement = await app.window.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="chat-context-budget-popover"]');
      const send = document.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
      if (!panel || !send) throw new Error('Popover and Send were not both mounted.');
      const box = panel.getBoundingClientRect();
      const sendBox = send.getBoundingClientRect();
      return {
        insideViewport:
          box.left >= -1 && box.top >= -1 &&
          box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
        clearOfSend: box.bottom <= sendBox.top + 1,
        clipped: panel.scrollHeight - panel.clientHeight,
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      };
    });
    expect(placement.insideViewport).toBe(true);
    expect(placement.clearOfSend).toBe(true);
    expect(placement.clipped).toBeLessThanOrEqual(1);
    expect(placement.bodyOverflowX).toBeLessThanOrEqual(1);

    // Escape closes it and hands focus back to the control that opened it.
    await app.window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(meter).toBeFocused();
    await expect(meter).toHaveAttribute('aria-expanded', 'false');
    expect(await meter.getAttribute('aria-controls')).toBeNull();

    // The keyboard opens it too: a real button, activated the ordinary way.
    await meter.press('Enter');
    await expect(popover).toBeVisible();
    await popover.getByTestId('chat-context-budget-close').click();
    await expect(popover).toHaveCount(0);
    await expect(meter).toBeFocused();

    await meter.press(' ');
    await expect(popover).toBeVisible();
    // A press somewhere else dismisses it, and the rest of the panel was never
    // made unreachable while it was open.
    await chat.getByTestId('chat-messages').click({ position: { x: 6, y: 6 } });
    await expect(popover).toHaveCount(0);
    await composer.fill('Still able to type after the popover closed.');
    await expect(composer).toHaveValue('Still able to type after the popover closed.');
    await composer.fill('');
  });

  test('closes the popover on Escape from anywhere in the panel, and when the tab changes', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    const meter = chat.getByTestId('chat-context-budget');
    const popover = app.window.getByTestId('chat-context-budget-popover');
    const composer = chat.getByLabel('Message Reader AI');
    await expect(meter).toBeVisible();

    // Opened, and then the reader carries on into the rest of the panel. Tab is
    // not trapped, so Escape has to be heard from wherever focus ended up — and
    // the application's own Escape handling must not be left holding a dialog
    // it will not close on the reader's behalf.
    await meter.click();
    await expect(popover).toBeFocused();
    await composer.focus();
    await expect(composer).toBeFocused();
    await app.window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(meter).toHaveAttribute('aria-expanded', 'false');
    // Focus stays where the reader put it rather than being dragged backwards.
    await expect(composer).toBeFocused();
    await composer.fill('Typed after Escape closed the panel from outside it.');
    await expect(composer).toHaveValue('Typed after Escape closed the panel from outside it.');
    await composer.fill('');

    // Switching companion tab from the keyboard takes the portalled panel with
    // it: the chat panel is only hidden, so nothing else would remove it and it
    // would float over Search with nothing beneath it.
    await meter.click();
    await expect(popover).toBeVisible();
    const chatTab = app.window.getByRole('tab', { name: 'Chat', exact: true });
    await chatTab.focus();
    await app.window.keyboard.press('ArrowRight');
    await expect(app.window.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    await expect(popover).toHaveCount(0);

    // Coming back shows the wheel closed rather than reopening a panel the
    // reader left behind on another tab.
    await app.window.keyboard.press('ArrowLeft');
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    await expect(meter).toBeVisible();
    await expect(meter).toHaveAttribute('aria-expanded', 'false');
    await expect(popover).toHaveCount(0);
  });

  test('keeps the wheel clear of Send at the minimum panel width and at 200%', async () => {
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat.getByTestId('chat-context-budget')).toBeVisible();

    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await app.window.waitForTimeout(350);

    const narrow = await app.window.evaluate(measureComposer);
    expect(narrow.overlapWithSend).toBe(0);
    expect(narrow.gapToSend).toBeGreaterThanOrEqual(4);
    expect(narrow.sameRow).toBe(true);
    expect(narrow.meterWidth).toBeGreaterThanOrEqual(24);
    expect(narrow.meterHeight).toBeGreaterThanOrEqual(24);
    expect(narrow.sendRight).toBeLessThanOrEqual(narrow.formRight + 1);
    expect(narrow.formOverflowX).toBeLessThanOrEqual(1);
    expect(narrow.bodyOverflowX).toBeLessThanOrEqual(1);

    await chat.getByTestId('chat-context-budget').click();
    await expect(app.window.getByTestId('chat-context-budget-popover')).toBeVisible();
    const narrowPanel = await app.window.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="chat-context-budget-popover"]');
      if (!panel) throw new Error('Popover was not mounted.');
      const box = panel.getBoundingClientRect();
      return {
        insideViewport: box.left >= -1 && box.top >= -1 && box.right <= window.innerWidth + 1,
        readable: panel.scrollHeight - panel.clientHeight,
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      };
    });
    expect(narrowPanel.insideViewport).toBe(true);
    expect(narrowPanel.readable).toBeLessThanOrEqual(1);
    expect(narrowPanel.bodyOverflowX).toBeLessThanOrEqual(1);
    await app.window.keyboard.press('Escape');

    // 200% zoom in the genuine window, with enough CSS width for the desktop
    // companion panel to stay mounted.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(2400, 1200);
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(920);
    expect(await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);

    const zoomedMeter = app.window.getByRole('region', { name: 'AI research chat' }).getByTestId('chat-context-budget');
    await expect(zoomedMeter).toBeVisible();
    const zoomed = await app.window.evaluate(measureComposer);
    expect(zoomed.overlapWithSend).toBe(0);
    expect(zoomed.gapToSend).toBeGreaterThanOrEqual(4);
    expect(zoomed.sameRow).toBe(true);
    // CSS pixels are unchanged by zoom; the control keeps its 24px target.
    expect(zoomed.meterWidth).toBeGreaterThanOrEqual(24);
    expect(zoomed.meterHeight).toBeGreaterThanOrEqual(24);
    expect(zoomed.sendRight).toBeLessThanOrEqual(zoomed.formRight + 1);
    expect(zoomed.formOverflowX).toBeLessThanOrEqual(1);
    expect(zoomed.bodyOverflowX).toBeLessThanOrEqual(1);

    await zoomedMeter.click();
    await expect(app.window.getByTestId('chat-context-budget-popover')).toBeVisible();
    const zoomedPanel = await app.window.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="chat-context-budget-popover"]');
      if (!panel) throw new Error('Popover was not mounted.');
      const box = panel.getBoundingClientRect();
      return {
        insideViewport:
          box.left >= -1 && box.top >= -1 &&
          box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
        readable: panel.scrollHeight - panel.clientHeight,
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      };
    });
    expect(zoomedPanel.insideViewport).toBe(true);
    expect(zoomedPanel.readable).toBeLessThanOrEqual(1);
    expect(zoomedPanel.bodyOverflowX).toBeLessThanOrEqual(1);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
      window.setSize(1400, 900);
    });
  });
});
