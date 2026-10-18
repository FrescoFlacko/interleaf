import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Geometry of the conversation cards and their metadata line, measured in the
 * real application. The metadata carries the archived and provider-unavailable
 * facts that used to have their own panel, so it is the longest line on a card
 * and the first thing a narrow or zoomed pane would clip.
 */
type CardGeometry = {
  readonly paneWidth: number;
  readonly bodyOverflowX: number;
  readonly listOverflowX: number;
  readonly cards: readonly {
    readonly testId: string;
    readonly metaText: string;
    readonly cardOverflowX: number;
    readonly metaOverflowX: number;
    readonly metaWidth: number;
    readonly metaHeight: number;
    readonly metaRight: number;
    readonly metaBottom: number;
    readonly contentRight: number;
    readonly contentBottom: number;
    readonly hidden: boolean;
  }[];
};

test.describe('Conversation card metadata at the minimum pane width', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-narrow-pane-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('keeps archived and provider-unavailable metadata readable at 280px and at 200% zoom', async () => {
    const pdfPath = join(fixtureDir, 'Chat_Sessions_Narrow_Pane_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Chat Sessions Narrow Pane Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic document for conversation card layout testing.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    // Seed two stored conversations: one bound to the current revision and one
    // left on an older revision, which is what makes it archived. Neither
    // provider is configured in this profile, so both are genuinely
    // unavailable — no metadata is simulated and no provider request is made.
    const dbPath = join(app.userDataDir, 'database', 'interleaf.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`
        INSERT INTO chat_sessions (id, document_id, document_hash, title, provider_id, model_id, created_at, updated_at)
        VALUES
          ('narrow-current', ?, ?, 'Consensus questions', 'openrouter', 'openrouter/auto', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')),
          ('narrow-archived', ?, 'stale-revision-hash', 'Notes on the previous revision', 'openrouter', 'openrouter/auto', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minutes'))
      `).run(doc!.id, doc!.fileHash, doc!.id);
      const message = db.prepare(`
        INSERT INTO chat_messages (id, session_id, role, ordinal, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'complete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minutes'))
      `);
      message.run('narrow-archived-1', 'narrow-archived', 'user', 0, 'How did the earlier revision describe quorum overlap?');
      message.run('narrow-archived-2', 'narrow-archived', 'assistant', 1, 'The earlier revision described quorum overlap as a majority intersection property.');
    } finally {
      db.close();
    }

    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');
    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    const openConversations = async (): Promise<void> => {
      const chatTab = app.window.getByRole('tab', { name: 'Chat' });
      await chatTab.click();
      await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
      const back = app.window.getByRole('button', { name: 'Back to conversations' });
      if (await back.count() > 0) await back.click();
      await expect(app.window.getByTestId('session-card-narrow-archived')).toBeVisible();
      // Provider discovery is asynchronous, and until its probe settles a card
      // reports readiness as unknown rather than unavailable — correctly, since
      // nothing has been established yet. The metadata line is only the longest
      // line on the card once that probe has answered, so the layout is
      // measured at that real readiness boundary rather than after a delay.
      for (const sessionId of ['narrow-current', 'narrow-archived']) {
        await expect(app.window.getByTestId(`session-meta-${sessionId}`))
          .toContainText('PROVIDER UNAVAILABLE');
      }
    };
    await openConversations();

    const measure = async (): Promise<CardGeometry> => app.window.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="session-card-narrow-archived"]')?.closest<HTMLElement>('[class*="chat-design-sessions"]');
      const body = document.querySelector<HTMLElement>('.chat-design-sessions-body');
      const list = document.querySelector<HTMLElement>('.chat-design-card-list');
      if (!pane || !body || !list) throw new Error('The Conversations screen was not mounted.');
      const cards = [...document.querySelectorAll<HTMLElement>('[data-testid^="session-card-"]')];
      return {
        paneWidth: body.clientWidth,
        bodyOverflowX: body.scrollWidth - body.clientWidth,
        listOverflowX: list.scrollWidth - list.clientWidth,
        cards: cards.map((card) => {
          const meta = card.querySelector<HTMLElement>('[data-testid^="session-meta-"]');
          if (!meta) throw new Error('A conversation card rendered without its metadata line.');
          const metaRect = meta.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          const cardStyle = getComputedStyle(card);
          const metaStyle = getComputedStyle(meta);
          return {
            testId: card.getAttribute('data-testid') ?? '',
            metaText: meta.textContent,
            cardOverflowX: card.scrollWidth - card.clientWidth,
            // A clipped line reports more scroll width than it can show.
            metaOverflowX: meta.scrollWidth - meta.clientWidth,
            metaWidth: metaRect.width,
            metaHeight: metaRect.height,
            metaRight: metaRect.right,
            metaBottom: metaRect.bottom,
            contentRight: cardRect.right - parseFloat(cardStyle.paddingRight || '0'),
            contentBottom: cardRect.bottom,
            hidden: metaStyle.visibility === 'hidden' || metaStyle.display === 'none',
          };
        }),
      };
    });

    const assertContained = (geometry: CardGeometry, label: string): void => {
      expect(geometry.bodyOverflowX, `${label}: sessions body must not scroll sideways`).toBeLessThanOrEqual(1);
      expect(geometry.listOverflowX, `${label}: card list must not scroll sideways`).toBeLessThanOrEqual(1);
      expect(geometry.cards.length).toBe(2);
      for (const card of geometry.cards) {
        expect(card.hidden, `${label}: ${card.testId} metadata must stay visible`).toBe(false);
        expect(card.metaWidth).toBeGreaterThan(0);
        expect(card.metaHeight).toBeGreaterThan(0);
        expect(card.cardOverflowX, `${label}: ${card.testId} must not scroll sideways`).toBeLessThanOrEqual(1);
        expect(card.metaOverflowX, `${label}: ${card.testId} metadata must not be clipped`).toBeLessThanOrEqual(1);
        expect(card.metaRight, `${label}: ${card.testId} metadata must stay inside the card`).toBeLessThanOrEqual(card.contentRight + 1);
        expect(card.metaBottom).toBeLessThanOrEqual(card.contentBottom + 1);
        expect(card.metaText).toContain('PROVIDER UNAVAILABLE');
      }
      const archived = geometry.cards.find((card) => card.testId === 'session-card-narrow-archived');
      expect(archived, `${label}: the archived card must be present`).toBeDefined();
      expect(archived!.metaText).toContain('ARCHIVED');
      expect(archived!.metaText).toContain('2 MSG');
    };

    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await app.window.waitForTimeout(350);

    const narrow = await measure();
    // The supported minimum for this pane; the body sits inside its padding.
    expect(narrow.paneWidth).toBeLessThanOrEqual(280);
    expect(narrow.paneWidth).toBeGreaterThan(200);
    assertContained(narrow, 'minimum pane width');

    // At 200% the shell falls below its 920px reflow threshold and presents the
    // companion panel as a drawer, so the same cards are measured there.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2.0);
    });
    await app.window.waitForTimeout(500);
    await app.window.getByTestId('toggle-right-panel').click();
    await expect(app.window.getByTestId('compact-drawer-right')).toBeVisible();
    await openConversations();

    const zoomed = await measure();
    assertContained(zoomed, '200% zoom');

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.0);
    });
  });
});
