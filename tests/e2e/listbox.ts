import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * User-level commands for the app's custom listbox `Select`: open the
 * combobox with a click, then click the option, as a pointer user does. The
 * open list is portalled, so it is found through the combobox's
 * `aria-controls` rather than inside the combobox's own subtree.
 */
async function openListbox(combobox: Locator): Promise<Locator> {
  if ((await combobox.getAttribute('aria-expanded')) !== 'true') await combobox.click();
  await expect(combobox).toHaveAttribute('aria-expanded', 'true');
  const listId = await combobox.getAttribute('aria-controls');
  if (listId === null) throw new Error('The select did not open a listbox.');
  return combobox.page().locator(`[id="${listId}"]`);
}

/** Choose the option with this stored value. */
export async function chooseListboxValue(combobox: Locator, value: string): Promise<void> {
  const list = await openListbox(combobox);
  await list.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(combobox).toHaveAttribute('data-value', value);
}

/** The visible label of every option, in order, leaving the value unchanged. */
export async function listboxOptionLabels(combobox: Locator): Promise<string[]> {
  const list = await openListbox(combobox);
  const labels = await list.locator('[role="option"]').evaluateAll((options) => options.map((option) => {
    const labelId = option.getAttribute('aria-labelledby');
    const label = labelId === null ? option : document.getElementById(labelId);
    return (label?.textContent ?? '').trim();
  }));
  await combobox.press('Escape');
  return labels;
}

/**
 * Choose a theme from the header Theme menu, as a reader does, and wait for it
 * to land on the root: the cross-fade applies it a frame after the click.
 */
export async function choosePalette(page: Page, palette: string): Promise<void> {
  await page.getByTestId('theme-menu-trigger').click();
  await page.getByTestId(`palette-option-${palette}`).click();
  await expect(page.getByTestId('theme-menu')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
}
