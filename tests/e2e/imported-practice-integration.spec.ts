import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWindowPng, launchInterleaf, returnToLibrary, stubOpenDialog } from './helpers';
import { createDiagnosticsClaudeFixture } from './diagnostics-claude-fixture';

test('retained unmatched export creates a due card with honest source evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-import-practice-'));
  const file = join(dir, 'My Clippings.txt');
  writeFileSync(file, 'Export Book (Writer)\n- Your Highlight on page 4 | Added today\n\nRecall this imported quote.\n==========\n');
  const claude = createDiagnosticsClaudeFixture(['The answer is supported by the export.']);
  claude.signIn();
  const profile = join(dir, 'profile');
  const app = await launchInterleaf({ binDir: claude.binDir, userDataDir: profile });
  try {
    await stubOpenDialog(app, [file]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    await app.window.getByRole('button', { name: 'Confirm import' }).click();
    await expect(app.window.getByText('Imported 1; skipped 0 duplicates.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Make practice card' }).click();
    await app.window.getByLabel('Question').fill('What did the export say?');
    await app.window.getByRole('button', { name: 'Save card' }).click();
    await expect(app.window.getByText('Practice card saved.')).toBeVisible();
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'import-card.png'));
    await app.window.getByRole('button', { name: 'Close', exact: true }).click();
    await app.window.getByRole('button', { name: 'Review practice' }).click();
    await expect(app.window.getByText('What did the export say?')).toBeVisible();
    await app.window.getByLabel('Your answer').fill('An answer');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await expect(app.window.getByText('Source status: export-only')).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Open source passage' })).toBeDisabled();
    await app.window.getByRole('button', { name: 'View exported highlight' }).click();
    await expect(app.window.getByRole('region', { name: 'Exported highlight record' })).toContainText('Recall this imported quote.');
    await app.window.evaluate(() => window.interleafAPI.ai.listProviders({ forceRefresh: true }));
    await app.window.getByRole('button', { name: 'Choose a provider for an optional check' }).click();
    await app.window.getByRole('combobox', { name: 'Provider and model' }).click();
    await app.window.getByRole('option', { name: /Claude/ }).first().click();
    await app.window.getByRole('button', { name: 'Send for source check' }).click();
    await expect(app.window.getByText('The answer is supported by the export.')).toBeVisible();
    expect(claude.chatPrompts().join('\n')).toContain('Recall this imported quote.');
    expect(claude.chatInvocations()).toHaveLength(1);
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'import-review.png'));
    const [card] = await app.window.evaluate(() => window.interleafAPI.practice.due(20));
    if (!card) throw new Error('Missing imported card');
    await app.window.getByRole('button', { name: 'good', exact: true }).click();
    await expect(app.window.getByText('Review complete.')).toBeVisible();
    await expect(app.window.evaluate((input) => window.interleafAPI.practice.rate(input), { cardId: card.id, revision: card.revision, rating: 'good' as const })).rejects.toThrow();
    await app.close();
    const restarted = await launchInterleaf({ binDir: claude.binDir, userDataDir: profile });
    try {
      const saved = await restarted.window.evaluate((id) => window.interleafAPI.practice.get(id), card.id);
      expect(saved).toMatchObject({ revision: 1, sourceState: 'export-only', evidence: 'Recall this imported quote.', source: { kind: 'imported' } });
      expect(await restarted.window.evaluate(() => window.interleafAPI.practice.due(20))).toHaveLength(0);
    } finally { await restarted.close(); }
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); rmSync(claude.binDir, { recursive: true, force: true }); }
});

test('a user verifies an exported quote against a unique saved book highlight and opens that passage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-verified-import-'));
  const book = join(dir, 'Book.md');
  const clipping = join(dir, 'My Clippings.txt');
  const quote = 'A verified unique export quote.';
  writeFileSync(book, `# Book\n\n${quote}\n`);
  writeFileSync(clipping, `Book (Writer)\n- Your Highlight on page 4 | Added today\n\n${quote}\n==========\n`);
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [book]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Missing fixture book');
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect.poll(() => app.window.evaluate(async (id) => (await window.interleafAPI.search.getIndexState(id))?.status, doc.id)).toBe('ready');
    await app.window.evaluate(async ({ id, text }) => { await window.interleafAPI.annotations.create({ documentId: id, type: 'highlight', color: 'yellow', selectedText: text,
      anchor: { format: 'markdown', blockIndex: 1, characterStart: 0, characterEnd: text.length, quote: { exact: text, prefix: '', suffix: '' } } }); }, { id: doc.id, text: quote });
    await returnToLibrary(app);
    await stubOpenDialog(app, [clipping]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await app.window.getByRole('button', { name: 'Confirm import' }).click();
    await expect(app.window.getByText('Imported 1; skipped 0 duplicates.')).toBeVisible();
    await app.window.getByRole('combobox', { name: 'Match saved Book' }).click();
    await app.window.getByRole('option', { name: 'Book', exact: true }).click();
    await app.window.getByRole('button', { name: 'Verify against saved highlight' }).click();
    await expect(app.window.getByText('Passage verified against a saved highlight and the current index.')).toBeVisible();
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await captureWindowPng(app, join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'verified-import.png'));
    await app.window.getByRole('button', { name: 'Make practice card' }).click();
    await app.window.getByLabel('Question').fill('Which quote was verified?');
    await app.window.getByRole('button', { name: 'Save card' }).click();
    await expect(app.window.getByText('Practice card saved.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Close', exact: true }).click();
    await app.window.getByRole('button', { name: 'Review practice' }).click();
    await app.window.getByLabel('Your answer').fill('The quote');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await expect(app.window.getByText('Source status: available')).toBeVisible();
    await app.window.getByRole('button', { name: 'Open source passage' }).click();
    await expect(app.window.getByText('Source passage opened.')).toBeVisible();
    await expect(app.window.getByTestId('reader-view')).toHaveAttribute('data-document-id', doc.id);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
