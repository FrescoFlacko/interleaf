import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, dismissOnboardingIfOpen, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { OPENROUTER_FIXTURE_CATALOG } from './main-network-guard';
import type { AppSettings } from '../../src/shared/schemas/settings';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue } from './listbox';

const VISUAL_DIR = process.env.INTERLEAF_VISUAL_DIR ?? join(process.cwd(), 'agent', 'visual');
const FIXED_TITLE = 'Leader Election Overview';

/**
 * Serves the guard's catalog plus a lightweight model, and answers the naming
 * prompt with a fixed title, recording the model each naming call asked for.
 * Every other completion falls through to the shared OpenRouter seam. Nothing
 * reaches the network: the seam sits on the guard.
 */
async function installTitleSeam(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate((_, input) => {
    const store = globalThis as { __titleModels?: string[] };
    store.__titleModels = [];
    const seamFetch = globalThis.fetch;
    globalThis.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      if (url.endsWith('/api/v1/models')) {
        const mini = { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini', context_length: 128_000, pricing: { prompt: '0.00000015', completion: '0.0000006' } };
        return Response.json({ data: [...input.catalog.data, mini] });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      if (!url.includes('/api/v1/chat/completions') || !body.includes('<first-question')) return seamFetch(request, init);
      store.__titleModels?.push((JSON.parse(body) as { model: string }).model);
      const stream = `data: {"choices":[{"delta":{"content":${JSON.stringify(input.title)}}}]}\n\ndata: [DONE]\n\n`;
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }, { title: FIXED_TITLE, catalog: OPENROUTER_FIXTURE_CATALOG });
  // Replace any catalog cached before the seam.
  await app.window.evaluate(async () => { await window.interleafAPI.ai.listOpenRouterModels({ forceRefresh: true }); });
}

async function titleModels(app: AppHandle): Promise<string[]> {
  return app.electronApp.evaluate(() => (globalThis as { __titleModels?: string[] }).__titleModels ?? []);
}

async function namingMode(page: Page): Promise<AppSettings['ai']['conversationNaming']> {
  return (await page.evaluate(async () => window.interleafAPI.settings.get())).ai.conversationNaming;
}

async function sessionTitles(page: Page, documentId: string): Promise<Record<string, string>> {
  return page.evaluate(async (docId) => Object.fromEntries(
    (await window.interleafAPI.chat.listSessions(docId)).map((session) => [session.id, session.title])
  ), documentId);
}

test.describe('Reader Chat automatic conversation naming', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    mkdirSync(VISUAL_DIR, { recursive: true });
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-ai-naming-'));
    app = await launchInterleaf();
    await configureOpenRouterTestSeam(app);
    await installTitleSeam(app);
    await dismissOnboardingIfOpen(app);
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('names new conversations automatically by default, with an explicit model, and not when Off, across restart', async () => {
    const page = app.window;
    const pdfPath = join(fixtureDir, 'AI_Naming_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'AI Naming Fixture',
      author: 'Interleaf',
      pageLines: [['Leader election picks one replica to coordinate writes in a consensus group.']],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [doc] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
    if (doc === undefined) throw new Error('Fixture was not imported.');
    await page.getByTestId(`read-doc-${doc.id}`).click();
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
    expect(await namingMode(page)).toBe('auto');

    await page.getByRole('tab', { name: 'Chat' }).click();
    const chat = page.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    const header = page.getByTestId('chat-conversation-line');
    const composer = page.getByLabel('Message Reader AI');
    /** Starts an OpenRouter conversation, asks one question and returns its id once answered. */
    const askInNewConversation = async (question: string): Promise<string> => {
      const before = Object.keys(await sessionTitles(page, doc.id));
      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(header).toHaveText(/^Conversation \d+$/u);
      await chooseChatModel(page, 'openrouter', 'openrouter/auto');
      let id = '';
      await expect.poll(async () => {
        id = Object.keys(await sessionTitles(page, doc.id)).find((candidate) => !before.includes(candidate)) ?? '';
        return id;
      }).not.toBe('');
      await composer.fill(question);
      await composer.press('Enter');
      await expect.poll(() => page.evaluate(async (sessionId) =>
        (await window.interleafAPI.chat.listMessages(sessionId)).filter((message) => message.status === 'complete').length, id)).toBe(2);
      return id;
    };

    // 1. Without visiting Settings, the conversation's own provider names it with its small model.
    const automatic = await askInNewConversation('How does leader election work?');
    await expect(header).toHaveText(FIXED_TITLE);
    expect(await titleModels(app)).toEqual(['openai/gpt-4o-mini']);
    await chat.screenshot({ path: join(VISUAL_DIR, 'ai-naming-header.png') });
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(page.getByTestId(`session-card-${automatic}`)).toContainText(FIXED_TITLE);
    await chat.screenshot({ path: join(VISUAL_DIR, 'ai-naming-history.png') });
    await page.getByTestId(`open-session-${automatic}`).click();

    // 2. Settings shows Automatic; an explicit model is used once chosen.
    const openNaming = async () => {
      await page.getByTestId('open-settings').click();
      const modal = page.getByTestId('ai-providers-settings-modal');
      const naming = modal.getByTestId('conversation-naming-section');
      await expect(naming).toBeVisible();
      return { modal, naming, providerSelect: naming.getByTestId('conversation-naming-provider') };
    };
    let settings = await openNaming();
    await expect(settings.providerSelect).toHaveAttribute('data-value', 'auto');
    await expect(settings.naming.getByTestId('conversation-naming-note')).toContainText('small model from each conversation');
    await settings.naming.screenshot({ path: join(VISUAL_DIR, 'ai-naming-settings-automatic.png') });
    await chooseListboxValue(settings.providerSelect, 'openrouter');
    expect(await namingMode(page)).toBe('auto');
    await chooseListboxValue(settings.naming.getByTestId('conversation-naming-model'), 'openai/gpt-4o');
    await expect.poll(() => namingMode(page)).toEqual({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    await settings.modal.getByRole('button', { name: 'Close settings' }).click();
    const explicit = await askInNewConversation('Which replica coordinates the writes?');
    await expect(header).toHaveText(FIXED_TITLE);
    expect(await titleModels(app)).toEqual(['openai/gpt-4o-mini', 'openai/gpt-4o']);

    // 3. Off: the next conversation keeps its numbered title.
    settings = await openNaming();
    await chooseListboxValue(settings.providerSelect, '');
    await expect.poll(() => namingMode(page)).toBeNull();
    await settings.modal.getByRole('button', { name: 'Close settings' }).click();
    const off = await askInNewConversation('What happens during a partition?');
    await page.waitForTimeout(500);
    await expect(header).toHaveText(/^Conversation \d+$/u);
    expect(await titleModels(app)).toHaveLength(2);

    // 4. Off and every title survive a restart.
    const titles = await sessionTitles(page, doc.id);
    expect(titles).toMatchObject({ [automatic]: FIXED_TITLE, [explicit]: FIXED_TITLE });
    expect(titles[off]).toMatch(/^Conversation \d+$/u);
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await dismissOnboardingIfOpen(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    expect(await namingMode(app.window)).toBeNull();
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    expect(await sessionTitles(app.window, doc.id)).toEqual(titles);
  });
});
