import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

test.describe('Defect 13 document card open/details interaction', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let markdownPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-card-details-'));
    markdownPath = join(fixtureDir, 'Card_Details_Contract.md');
    writeFileSync(
      markdownPath,
      makeMarkdownFixture({
        title: 'Card Details Contract',
        author: 'Interleaf QA',
        body: '# Card Details Contract\n\nThe primary card surface opens this document in the reader.\n',
      })
    );
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('opens from the card surface, isolates ellipsis details, supports keyboard and persists across restart', async () => {
    await stubOpenDialog(app, [markdownPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('1 document');

    const importedDocument = (await app.window.evaluate(async () => window.interleafAPI.library.listDocuments()))[0]!;
    const card = app.window.getByTestId(`document-card-${importedDocument.id}`);
    const open = app.window.getByRole('button', { name: `Open ${importedDocument.title}` });
    const menu = app.window.getByRole('button', { name: `More actions for ${importedDocument.title}` });
    await expect(card).toBeVisible();

    // Pointer activation on the primary card surface enters the reader.
    await card.click({ position: { x: 8, y: 8 } });
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-document-title')).toHaveText(importedDocument.title);
    await returnToLibrary(app);
    await expect(card).toBeVisible();

    // Keyboard activation is a native button contract; Playwright sends the
    // real Space key so Chromium performs the same click as a user.
    await open.focus();
    await app.window.keyboard.press('Space');
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await returnToLibrary(app);
    await expect(card).toBeVisible();

    // The ellipsis is a separate action and must never open the reader.
    await menu.focus();
    await app.window.keyboard.press('Enter');
    const details = app.window.getByRole('dialog', { name: 'Document details' });
    await expect(details).toBeVisible();
    await expect(app.window.getByText('Storage Mode')).toBeVisible();
    await expect(app.window.getByText('Storage Health')).toBeVisible();
    // The content hash is machine identity rather than something the reader
    // acts on, so the dialog no longer prints it.
    await expect(app.window.getByText('SHA-256 Hash')).toHaveCount(0);
    await expect(app.window.getByTestId('reader-view')).toHaveCount(0);
    await app.window.keyboard.press('Escape');
    await expect(menu).toBeFocused();

    // Transitioning from details into either secondary modal keeps exactly one
    // dialog mounted and returns Escape to the original ellipsis trigger.
    await menu.click();
    // Read is the dialog's one visible command; Move, Remove from folder and
    // Delete share the compact actions menu, and the redundant footer Close is
    // gone in favour of the header X, Escape and the backdrop.
    await expect(details.getByTestId('open-reader-button')).toBeVisible();
    await expect(details.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await details.getByTestId('document-details-actions-trigger').click();
    const actionsMenu = details.getByRole('menu', { name: 'Document actions' });
    await expect(actionsMenu).toBeVisible();
    await actionsMenu.getByRole('menuitem', { name: 'Move...' }).click();
    const moveDialog = app.window.getByRole('dialog', { name: 'Move document to folder' });
    await expect(moveDialog).toBeVisible();
    await expect(details).toHaveCount(0);
    await expect.poll(async () => app.window.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="move-document-modal"]');
      return Boolean(dialog?.contains(document.activeElement));
    })).toBe(true);
    await app.window.keyboard.press('Escape');
    await expect(moveDialog).toHaveCount(0);
    await expect(menu).toBeFocused();

    await menu.click();
    await details.getByTestId('document-details-actions-trigger').click();
    await details.getByRole('menuitem', { name: 'Delete' }).click();
    const deleteDialog = app.window.getByRole('alertdialog', { name: 'Delete document' });
    await expect(deleteDialog).toBeVisible();
    await expect(details).toHaveCount(0);
    await expect.poll(async () => app.window.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="delete-document-modal"]');
      return Boolean(dialog?.contains(document.activeElement));
    })).toBe(true);
    await app.window.keyboard.press('Escape');
    await expect(deleteDialog).toHaveCount(0);
    await expect(menu).toBeFocused();

    // Outside click closes the details surface without invoking any document action.
    await menu.click();
    await app.window.getByTestId('document-details-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(details).toHaveCount(0);
    await expect(menu).toBeFocused();
    await expect(app.window.getByTestId('reader-view')).toHaveCount(0);

    // List view uses the same semantic contract: the row's primary button
    // opens, while the ellipsis is the only visible secondary action.
    await app.window.getByTestId('list-view-toggle').click();
    const row = app.window.getByTestId(`document-row-${importedDocument.id}`);
    const rowOpen = app.window.getByTestId(`read-row-doc-${importedDocument.id}`);
    const rowMenu = app.window.getByTestId(`document-menu-${importedDocument.id}`);
    await expect(row).toBeVisible();
    await expect(rowOpen).toBeVisible();
    await expect(rowMenu).toBeVisible();
    await expect(app.window.getByTestId(`move-doc-${importedDocument.id}`)).toHaveCount(0);
    await expect(app.window.getByTestId(`delete-doc-${importedDocument.id}`)).toHaveCount(0);
    await row.click({ position: { x: 8, y: 8 } });
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await returnToLibrary(app);
    await expect(row).toBeVisible();
    await rowOpen.focus();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await returnToLibrary(app);
    await expect(row).toBeVisible();
    await rowMenu.focus();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByRole('dialog', { name: 'Document details' })).toBeVisible();
    await expect(app.window.getByTestId('reader-view')).toHaveCount(0);
    await app.window.keyboard.press('Escape');
    await expect(rowMenu).toBeFocused();
    await app.window.getByTestId('grid-view-toggle').click();
    await expect(card).toBeVisible();

    // The ellipsis opens the real details surface at normal scale.
    await menu.click();
    await expect(details).toBeVisible();
    await app.window.keyboard.press('Escape');

    // Real BrowserWindow zoom: no CSS zoom, clones, or test-only panel.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1400, 900);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.webContents.getZoomFactor() ?? 0;
    })).toBe(2);
    const gridContainment = await app.window.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid^="document-card-"]');
      const menuButton = document.querySelector<HTMLElement>('[data-testid^="document-menu-"]');
      return {
        cardContained: card ? card.getBoundingClientRect().right <= window.innerWidth : false,
        menuContained: menuButton ? menuButton.getBoundingClientRect().right <= window.innerWidth : false,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth,
      };
    });
    expect(gridContainment).toEqual({ cardContained: true, menuContained: true, horizontalOverflow: false });

    await app.window.getByTestId('list-view-toggle').click();
    await expect(row).toBeVisible();
    const listContainment = await app.window.evaluate(() => {
      const rowElement = document.querySelector<HTMLElement>('[data-testid^="document-row-"]');
      const menuButton = document.querySelector<HTMLElement>('[data-testid^="document-menu-"]');
      return {
        rowContained: rowElement ? rowElement.getBoundingClientRect().right <= window.innerWidth : false,
        menuContained: menuButton ? menuButton.getBoundingClientRect().right <= window.innerWidth : false,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth,
      };
    });
    expect(listContainment).toEqual({ rowContained: true, menuContained: true, horizontalOverflow: false });
    await rowMenu.scrollIntoViewIfNeeded();
    await rowMenu.click();
    await expect(details).toBeVisible();
    const containment = await app.window.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="document-details-modal"]');
      const root = document.documentElement;
      const body = document.body;
      if (!dialog) return null;
      const box = dialog.getBoundingClientRect();
      return {
        dialogContained: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
        horizontalOverflow: root.scrollWidth > root.clientWidth || body.scrollWidth > body.clientWidth,
        focusInside: dialog.contains(document.activeElement),
      };
    });
    expect(containment).not.toBeNull();
    expect(containment?.dialogContained).toBe(true);
    expect(containment?.horizontalOverflow).toBe(false);
    const dialogHasFocus = async (): Promise<boolean> => app.window.evaluate((): boolean => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="document-details-modal"]');
      return Boolean(dialog?.contains(document.activeElement));
    });
    await expect.poll(dialogHasFocus).toBe(true);
    // The overflow menu is the dialog's only secondary surface, so it has to
    // stay inside the window at 200% too.
    await details.getByTestId('document-details-actions-trigger').click();
    await expect(details.getByRole('menu', { name: 'Document actions' })).toBeVisible();
    const menuContainment = await app.window.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[role="menu"][aria-label="Document actions"]');
      if (!surface) return null;
      const box = surface.getBoundingClientRect();
      return {
        contained: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(menuContainment).toEqual({ contained: true, horizontalOverflow: false });
    await app.window.keyboard.press('Escape');
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.0);
    });

    // Persisted library metadata survives a real application restart.
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await expect(app.window.getByTestId(`document-card-${importedDocument.id}`)).toBeVisible();
  });
});
