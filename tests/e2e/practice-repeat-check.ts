import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Frame, type Page } from '@playwright/test';
import type { PracticeCard } from '@shared/schemas/practice';
import { launchInterleaf, type AppHandle } from './helpers';

type Options = {
  app: AppHandle;
  documentId: string;
  savedCard: PracticeCard;
  format: 'markdown' | 'epub' | 'mobi';
  reflow: boolean;
  evidenceDir: string | undefined;
  frame: () => Page | Frame;
  quotePosition: (frame: Page | Frame) => Promise<{ visible: boolean }>;
};

/** Verify the same saved source remains eligible after the reader repairs its anchor. */
async function verifyRepair({ app, documentId, savedCard, format }: Options): Promise<void> {
  await app.window.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => { if (++frames === 25) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  const [repaired] = await app.window.evaluate((id) => window.interleafAPI.annotations.list(id), documentId);
  const [currentCard] = await app.window.evaluate(() => window.interleafAPI.practice.due(20));
  expect(currentCard?.id).toBe(savedCard.id);
  expect(currentCard?.source).toEqual(savedCard.source);
  expect(currentCard?.evidence).toBe(savedCard.evidence);
  expect(currentCard?.sourceState).toBe('available');
  if (format === 'epub' || format === 'mobi') {
    if (savedCard.source.kind !== 'native' || repaired?.anchor.format !== format || savedCard.source.anchor.format !== format) throw new Error('Ebook source changed format');
    expect(repaired.anchor.progression).not.toBe(savedCard.source.anchor.progression);
    expect({ ...repaired.anchor, progression: savedCard.source.anchor.progression }).toEqual(savedCard.source.anchor);
  }
}

async function verifyRestart({ app, evidenceDir, quotePosition }: Options): Promise<void> {
  await app.close({ preserveUserData: true });
  const restarted = await launchInterleaf({ userDataDir: app.userDataDir });
  try {
    await restarted.window.getByRole('button', { name: 'Review practice', exact: true }).click();
    await restarted.window.getByLabel('Your answer').fill('After restart');
    await restarted.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
    await expect(restarted.window.getByText('Source status: available', { exact: true })).toBeVisible();
    await restarted.window.getByRole('button', { name: 'Open source passage', exact: true }).click();
    await expect(restarted.window.getByText('Source passage opened.', { exact: true })).toBeVisible();
    const restartedFrame = restarted.window.frames().find((item) => item.parentFrame() !== null);
    if (!restartedFrame) throw new Error('Restarted ebook frame not mounted');
    expect((await quotePosition(restartedFrame)).visible).toBe(true);
    if (evidenceDir) await restarted.window.screenshot({ path: join(evidenceDir, 'epub-restart-source.png') });
  } finally { await restarted.close(); }
}

export async function verifyRepeatedPracticeSource(options: Options): Promise<void> {
  const { app, format, reflow, evidenceDir, frame, quotePosition } = options;
  await verifyRepair(options);
  if (reflow) {
    const browserWindow = await app.electronApp.browserWindow(app.window);
    await browserWindow.evaluate((win) => { win.setSize(1100, 750); });
    await expect.poll(() => browserWindow.evaluate((win) => { const { width } = win.getBounds(); return width === 1100; })).toBe(true);
  }
  await app.window.getByTestId('sidebar-library').locator('nav[aria-label="Library sections"] button').first().click();
  await expect(app.window.getByTestId('practice-review')).toBeVisible();
  await app.window.getByLabel('Your answer').fill('At the end again');
  await app.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
  await expect(app.window.getByText('Source status: available', { exact: true })).toBeVisible();
  const openAgain = app.window.getByRole('button', { name: 'Open source passage', exact: true });
  await expect(openAgain).toBeEnabled();
  const name = `${format}${reflow ? '-reflow' : ''}`;
  if (evidenceDir) await app.window.screenshot({ path: join(evidenceDir, `${name}-repeat-review.png`) });
  await openAgain.click();
  await expect(app.window.getByText('Source passage opened.', { exact: true })).toBeVisible();
  const repeated = await quotePosition(frame());
  expect(repeated.visible, 'Reopening the same card must show the passage').toBe(true);
  if (evidenceDir) {
    writeFileSync(join(evidenceDir, `${name}-repeat-position.json`), JSON.stringify(repeated, null, 2));
    await app.window.screenshot({ path: join(evidenceDir, `${name}-repeat-source.png`) });
  }
  if (format === 'epub' && reflow) await verifyRestart(options);
}
