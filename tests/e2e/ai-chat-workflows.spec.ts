import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Opens a conversation from the Conversations screen. The card that is already
 * current carries its inline Resume action; every other card opens from its own
 * card surface.
 */
async function openPersistedSession(window: Page, sessionId: string): Promise<void> {
  const card = window.getByTestId(`session-card-${sessionId}`);
  await card.waitFor();
  const openControl = window.getByTestId(`open-session-${sessionId}`);
  if ((await openControl.count()) > 0) {
    await openControl.click();
    return;
  }
  await card.getByTestId('resume-chat-session').click();
}

test.describe('Phase 7 End-to-End Acceptance Workflows (E, F, G)', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-e2e-'));
    app = await launchInterleaf();
    await configureOpenRouterTestSeam(app);
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('Workflow E: Ask AI from Highlight & Clickable Citation Jump', async () => {
    // 1. Generate multi-page PDF with distinct text targets
    const samplePdfPath = join(fixtureDir, 'Workflow_E_Distributed_Systems.pdf');
    const pdfBuffer = makePdfFixture({
      title: 'Workflow E Guide',
      author: 'Martin Kleppmann',
      pageLines: [
        [
          'Chapter 1: Foundations of Fault-Tolerant Distributed Consensus.',
          'Consensus algorithm passage to highlight for AI research.',
          'Closing detail on page one.',
        ],
        ['Chapter 2: Data Models and Replication Topologies.'],
        ['Chapter 3: Storage Engine Internals.'],
      ],
      outline: [
        { title: 'Chapter 1', targetPage: 1 },
        { title: 'Chapter 2', targetPage: 2 },
        { title: 'Chapter 3', targetPage: 3 },
      ],
    });
    writeFileSync(samplePdfPath, pdfBuffer);

    // 2. Import and open the document
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [pdfDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(pdfDoc).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

    // 3. Create a real reader selection on the text layer
    const targetText = 'Consensus algorithm passage to highlight';
    await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer, target) => {
      const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = layer.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = layer.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error(`Target text '${target}' was not found in text layer.`);
    }, targetText);

    // 4. Verify selection toolbar appears with "Ask AI" button
    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();

    const askAiButton = selectionToolbar.getByRole('button', { name: 'Ask AI' });
    await expect(askAiButton).toBeVisible();
    await askAiButton.click();
    // 5. Prove: Chat panel opens, selected passage becomes context chip, and composer is focused
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    const contextSummary = app.window.getByTestId('chat-context-summary');
    await expect(contextSummary).toBeVisible();
    await expect(contextSummary.getByText(/Consensus algorithm passage to highlight/)).toBeVisible();

    const composer = app.window.getByLabel('Message Reader AI');
    await expect(composer).toBeFocused();
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');

    // 6. Register stream event listener through typed bridge before sending
    await app.window.evaluate(() => {
      const events: { type: string; token?: string; requestId: string; sessionId: string }[] = [];
      window.__streamEvents = events;
      window.interleafAPI.chat.onStreamEvent((event) => {
        events.push({
          type: event.type,
          ...(event.type === 'token' ? { token: event.token } : {}),
          requestId: event.requestId,
          sessionId: event.sessionId,
        });
      });
    });

    // 7. Send question through UI composer
    await composer.fill('What are the key invariants of this consensus passage?');
    await composer.press('Enter');

    // 8. Prove response streams into UI and contains citation chip
    let activeSessionId = '';
    let assistantRequestId = '';
    let assistantContent = '';
    await expect.poll(async () => {
      const sessions = await app.window.evaluate(async (docId) =>
        window.interleafAPI.chat.listSessions(docId),
      pdfDoc!.id);
      const active = sessions[0];
      if (!active) return null;
      activeSessionId = active.id;
      const messages = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listMessages(sessionId),
      active.id);
      const assistant = messages.find((m) => m.role === 'assistant');
      if (assistant?.status === 'complete') {
        assistantRequestId = assistant.requestId ?? '';
        assistantContent = assistant.content;
        return assistant.status;
      }
    }).toBe('complete');

    // 9. Assert stream events were captured over the IPC push bridge for this authoritative turn
    const observedEvents = await app.window.evaluate(() => {
      return window.__streamEvents;
    });
    const relevantEvents = observedEvents.filter(
      (e) => e.sessionId === activeSessionId && e.requestId === assistantRequestId
    );
    const tokenEvents = relevantEvents.filter((e) => e.type === 'token');
    const doneEvents = relevantEvents.filter((e) => e.type === 'done');

    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(doneEvents).toHaveLength(1);
    const concatenatedTokens = tokenEvents.map((t) => t.token).join('');
    expect(concatenatedTokens.trim()).toBe(assistantContent.trim());

    // 10. Verify assistant message displays the reconstructed content and citation chip [p. 1]
    const assistantArticle = app.window.getByRole('article').filter({ hasText: 'Reader AI' });
    await expect(assistantArticle).toBeVisible();
    const answerBeforeCitation = assistantContent.split(/\[src-\d+\]/u, 1)[0]?.trim() ?? '';
    expect(answerBeforeCitation).not.toBe('');
    await expect(assistantArticle).toContainText(answerBeforeCitation);

    const citationChip = assistantArticle.getByRole('button', { name: /p\. 1/i });
    await expect(citationChip).toBeVisible();
    // 11. Navigate reader to Page 2
    const nextBtn = app.window.getByTestId('next-page-button');
    await nextBtn.click();
    const pageInput = app.window.getByLabel('Page number');
    await expect(pageInput).toHaveValue('2');

    // 12. Activate citation chip
    await citationChip.click();

    // 13. Prove reader navigation jumps back to Page 1
    await expect(pageInput).toHaveValue('1');
  });

  test('Workflow F: Explicit Page Range AI Context (Pages 42–45)', async () => {
    // 1. Create a deterministic 48-page PDF fixture with exact page text on pages 42-45
    const samplePdfPath = join(fixtureDir, 'Workflow_F_Large_48_Pages.pdf');
    const pageLines: string[][] = [];
    for (let i = 1; i <= 48; i++) {
      if (i === 42) {
        pageLines.push([
          'Page 42: Consensus protocol foundation and quorum read/write definitions.',
          'State machine replication relies on strict majority quorums.',
        ]);
      } else if (i === 43) {
        pageLines.push([
          'Page 43: Leader election timeout mechanisms and randomized heartbeat intervals.',
          'Split vote avoidance in leader election phases.',
        ]);
      } else if (i === 44) {
        pageLines.push([
          'Page 44: Log replication safety, commit index progression, and term invariants.',
          'Follower log consistency checks across term boundaries.',
        ]);
      } else if (i === 45) {
        pageLines.push([
          'Page 45: Strict serializability across partition boundaries and linearizable reads.',
          'Read index verification with leader lease leases.',
        ]);
      } else {
        pageLines.push([`Chapter Section on Page ${String(i)}: Background information and architecture notes.`]);
      }
    }

    const pdfBuffer = makePdfFixture({
      title: 'Workflow F 48-Page Guide',
      author: 'Martin Kleppmann',
      pageLines,
    });
    writeFileSync(samplePdfPath, pdfBuffer);

    // 2. Import and open the 48-page PDF document
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [pdfDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(pdfDoc).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    // 3. Wait for background search indexing to complete
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    pdfDoc!.id)).toBe('ready');

    // 4. Open the AI Chat companion tab
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    // 5. Explicitly click "New chat" to create a fresh session
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    const newChatBtn = app.window.getByRole('button', { name: 'New chat' });
    await newChatBtn.click();

    const composer = app.window.getByLabel('Message Reader AI');
    await expect(composer).toBeEnabled();

    // 6. Open the accessible Pages popover and enter page range 42 to 45
    const pagesTrigger = app.window.getByRole('button', { name: 'Add context' });
    await pagesTrigger.click();
    await expect(app.window.getByTestId('chat-pages-popover')).toBeVisible();
    const startInput = app.window.getByLabel('Start page for context');
    const endInput = app.window.getByLabel('End page for context');

    await startInput.fill('42');
    await endInput.fill('45');

    await app.window.getByRole('button', { name: 'Add range' }).click();
    await expect(pagesTrigger).toBeFocused();

    // 7. Verify context chip "Pages 42–45" is displayed
    const contextSummary = app.window.getByTestId('chat-context-summary');
    await expect(contextSummary.getByText('Pages 42–45')).toBeVisible();

    // 8. Send question via UI
    await composer.fill('Summarize consensus protocol across these pages');
    await composer.press('Enter');

    // 9. Wait for response to complete
    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (docId) => {
        const sessions = await window.interleafAPI.chat.listSessions(docId);
        const active = sessions[0];
        if (!active) return [];
        return window.interleafAPI.chat.listMessages(active.id);
      }, pdfDoc!.id);
      const assistant = messages.find((m) => m.role === 'assistant');
      return assistant?.status;
    }).toBe('complete');

    // 10. Verify assistant message displays citation chip for Pages 42–45 scoped to the message
    const citationButton = app.window.getByRole('article').getByRole('button', { name: /p\. 42–45|Pages 42–45/i });
    await expect(citationButton).toBeVisible();

    // 11. Attached context is persistent: a send consumes the range as the
    // turn's snapshot but does not silently detach it. The chip and its
    // session context item survive the send until the user removes them.
    const activeSession = await app.window.evaluate(async (docId) => {
      const sessions = await window.interleafAPI.chat.listSessions(docId);
      return sessions[0]!;
    }, pdfDoc!.id);

    await expect(contextSummary.getByText('Pages 42–45')).toBeVisible();
    const contextItems = await app.window.evaluate(async (sessionId) =>
      window.interleafAPI.chat.listContext(sessionId),
    activeSession.id);
    expect(contextItems).toHaveLength(1);
    expect(contextItems[0]!.displayLabel).toBe('Pages 42–45');

    // 12. Assert directly in SQLite that the turn's source snapshot was
    // honestly persisted beside the still-attached composer context item.
    const dbPath = join(app.userDataDir, 'database', 'interleaf.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const contextRows = db.prepare(
        'SELECT * FROM chat_context_items WHERE session_id = ?'
      ).all(activeSession.id) as { display_label: string }[];
      expect(contextRows).toHaveLength(1);
      expect(contextRows[0]!.display_label).toBe('Pages 42–45');

      const sourceRow = db.prepare(
        `SELECT cms.* FROM chat_message_sources cms
           JOIN chat_messages cm ON cm.id = cms.message_id
          WHERE cm.session_id = ? AND cm.role = 'assistant'`
      ).get(activeSession.id) as {
        page_label: string;
        display_label: string;
        excerpt_text: string;
      };
      expect(sourceRow).toBeDefined();
      expect(sourceRow.page_label).toBe('42–45');
      expect(sourceRow.display_label).toBe('Pages 42–45');
      expect(sourceRow.excerpt_text).toContain('Page 42: Consensus protocol foundation');
      expect(sourceRow.excerpt_text).toContain('Page 45: Strict serializability');
    } finally {
      db.close();
    }

    // 13. Explicit removal — and only explicit removal — detaches the range.
    // The already-sent turn keeps its recorded sources afterwards.
    await contextSummary.click();
    await app.window.getByTestId('chat-context-list')
      .getByRole('button', { name: 'Remove Pages 42–45 from AI context' })
      .click();
    await expect(app.window.getByTestId('chat-context-bar').getByText('Pages 42–45')).toHaveCount(0);

    await expect.poll(async () => {
      const items = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listContext(sessionId),
      activeSession.id);
      return items.length;
    }).toBe(0);

    const dbAfterRemoval = new DatabaseSync(dbPath);
    try {
      const contextRows = dbAfterRemoval.prepare(
        'SELECT * FROM chat_context_items WHERE session_id = ?'
      ).all(activeSession.id);
      expect(contextRows).toHaveLength(0);

      // The turn's own record is history and is not rewritten by detaching: the
      // attached range it was answered with is still one of its sources.
      const remainingSources = dbAfterRemoval.prepare(
        `SELECT cms.* FROM chat_message_sources cms
           JOIN chat_messages cm ON cm.id = cms.message_id
          WHERE cm.session_id = ? AND cm.role = 'assistant' AND cms.attached_origin = 1`
      ).all(activeSession.id) as { display_label: string }[];
      expect(remainingSources).toHaveLength(1);
      expect(remainingSources[0]!.display_label).toBe('Pages 42–45');
    } finally {
      dbAfterRemoval.close();
    }

    // The citation chip on the delivered answer is unaffected by detaching.
    await expect(citationButton).toBeVisible();
  });

  test('Workflow G: Multi-Session Chat Switcher & Persistence across Restart', async () => {
    // 1. Create a PDF fixture and open it
    const samplePdfPath = join(fixtureDir, 'Workflow_G_Multi_Session.pdf');
    const pdfBuffer = makePdfFixture({
      title: 'Workflow G Document',
      author: 'Leslie Lamport',
      pageLines: [
        ['Chapter 1: Multi-Paxos, Raft, and Distributed State Machine Replication.'],
        ['Chapter 2: Byzantine Fault Tolerance and Asynchronous Networks.'],
      ],
    });
    writeFileSync(samplePdfPath, pdfBuffer);

    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [pdfDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(pdfDoc).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    // 2. Open AI Chat companion panel
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    // 3. Explicitly create Session 1 via UI
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    const newChatBtn = app.window.getByRole('button', { name: 'New chat' });
    await newChatBtn.click();

    const composer = app.window.getByLabel('Message Reader AI');
    await expect(composer).toBeEnabled();

    // In Session 1: Send Message 1 and Message 2
    await composer.fill('Session 1 Question 1: What is consensus?');
    await composer.press('Enter');

    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (docId) => {
        const sessions = await window.interleafAPI.chat.listSessions(docId);
        const active = sessions[0];
        if (!active) return 0;
        return (await window.interleafAPI.chat.listMessages(active.id)).filter((m) => m.status === 'complete').length;
      }, pdfDoc!.id);
      return messages;
    }).toBe(2);

    await composer.fill('Session 1 Question 2: How do quorums guarantee consistency?');
    await composer.press('Enter');

    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (docId) => {
        const sessions = await window.interleafAPI.chat.listSessions(docId);
        const active = sessions[0];
        if (!active) return 0;
        return (await window.interleafAPI.chat.listMessages(active.id)).filter((m) => m.status === 'complete').length;
      }, pdfDoc!.id);
      return messages;
    }).toBe(4);

    // Verify Session 1 has 4 messages rendered in the UI
    await expect(app.window.getByText('Session 1 Question 1: What is consensus?')).toBeVisible();
    await expect(app.window.getByText('Session 1 Question 2: How do quorums guarantee consistency?')).toBeVisible();

    // 4. Explicitly create Session 2 via UI. Creating opens the new thread, so
    // the header naming it is the point at which the conversation exists for
    // the user; navigating before that raced the create, which then re-entered
    // the thread and detached the Conversations screen mid-click.
    await newChatBtn.click();
    await expect(app.window.getByTestId('chat-conversation-line')).toHaveText('Conversation 2');

    // Rename Session 2 on its own card
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await app.window.getByTestId('rename-chat-session').click();
    const renameInput = app.window.getByLabel('Edit chat session title');
    await renameInput.fill('Fault Tolerance Chat');
    await renameInput.press('Enter');

    // Verify the conversation card reflects the renamed title
    let renamedSessionId = '';
    await expect.poll(async () => {
      renamedSessionId = await app.window.evaluate(async (docId) => {
        const sessions = await window.interleafAPI.chat.listSessions(docId);
        return sessions.find((s) => s.title === 'Fault Tolerance Chat')?.id ?? '';
      }, pdfDoc!.id);
      return renamedSessionId;
    }).not.toBe('');
    await expect(app.window.getByTestId(`session-card-${renamedSessionId}`)).toContainText('Fault Tolerance Chat');

    // 5. Send message in Session 2
    await app.window.getByTestId('resume-chat-session').click();
    await expect(app.window.getByTestId('chat-conversation-line')).toHaveText('Fault Tolerance Chat');
    // The provider binding belongs to the conversation, not to the panel: a
    // conversation created without an explicit choice binds the configured
    // default, so Session 2 has to be pointed at the seam the same way
    // Session 1 was.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await composer.fill('Session 2 Question 1: How do network partitions behave?');
    await composer.press('Enter');

    await expect.poll(async () => {
      const sessionCount = await app.window.evaluate(async (docId) => {
        const sessions = await window.interleafAPI.chat.listSessions(docId);
        const active = sessions.find((s) => s.title === 'Fault Tolerance Chat');
        if (!active) return 0;
        return (await window.interleafAPI.chat.listMessages(active.id)).filter((m) => m.status === 'complete').length;
      }, pdfDoc!.id);
      return sessionCount;
    }).toBe(2);

    await expect(app.window.getByText('Session 2 Question 1: How do network partitions behave?')).toBeVisible();

    // 6. Switch back to Session 1 from its card (auto-named "Conversation 1")
    const firstSessionId = await app.window.evaluate(async (docId) => {
      const sessions = await window.interleafAPI.chat.listSessions(docId);
      return sessions.find((s) => s.title === 'Conversation 1')?.id ?? '';
    }, pdfDoc!.id);
    expect(firstSessionId).not.toBe('');
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await app.window.getByTestId(`open-session-${firstSessionId}`).click();

    // Verify Session 1 messages are restored in UI
    await expect(app.window.getByText('Session 1 Question 1: What is consensus?')).toBeVisible();
    await expect(app.window.getByText('Session 1 Question 2: How do quorums guarantee consistency?')).toBeVisible();
    await expect(app.window.getByText('Session 2 Question 1: How do network partitions behave?')).toHaveCount(0);

    // 7. Switch back to Session 2 from its card
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await app.window.getByTestId(`open-session-${renamedSessionId}`).click();
    await expect(app.window.getByText('Session 2 Question 1: How do network partitions behave?')).toBeVisible();
    await expect(app.window.getByText('Session 1 Question 1: What is consensus?')).toHaveCount(0);

    // 8. Restart the application and prove SQLite persistence
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });

    const relaunched = await launchInterleaf({ userDataDir });
    try {
      // Reopen document in reader
      await expect(relaunched.window.getByTestId('library-view')).toBeVisible();
      await relaunched.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
      await expect(relaunched.window.getByTestId('pdf-canvas-p1')).toBeVisible();

      // Open Chat panel
      await relaunched.window.getByRole('tab', { name: 'Chat' }).click();
      await expect(relaunched.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

      await relaunched.window.getByRole('button', { name: 'Back to conversations' }).click();

      // Open Session 1 (auto-named "Conversation 1" — persisted across restart)
      await openPersistedSession(relaunched.window, firstSessionId);
      await expect(relaunched.window.getByText('Session 1 Question 1: What is consensus?')).toBeVisible();
      await expect(relaunched.window.getByText('Session 1 Question 2: How do quorums guarantee consistency?')).toBeVisible();

      // Open Session 2
      await relaunched.window.getByRole('button', { name: 'Back to conversations' }).click();
      await openPersistedSession(relaunched.window, renamedSessionId);
      await expect(relaunched.window.getByText('Session 2 Question 1: How do network partitions behave?')).toBeVisible();
    } finally {
      await relaunched.close();
    }
  });
});
