import { fireEvent, within } from '@testing-library/react';

/**
 * User-level commands for the app's custom listbox `Select`: open the
 * combobox as a pointer user does, then choose the option by its visible
 * name. Works for any combobox, located however the test prefers.
 */
export function openSelect(combobox: HTMLElement): HTMLElement {
  if (combobox.getAttribute('aria-expanded') !== 'true') fireEvent.click(combobox);
  const listId = combobox.getAttribute('aria-controls');
  if (listId === null) throw new Error('The select did not open a listbox.');
  const list = document.getElementById(listId);
  if (list === null) throw new Error(`Listbox ${listId} is not in the document.`);
  return list;
}

export function chooseOption(combobox: HTMLElement, name: string | RegExp): void {
  const list = openSelect(combobox);
  fireEvent.click(within(list).getByRole('option', { name }));
}

/** Choose by stored value rather than by label, for value-driven tests. */
export function chooseValue(combobox: HTMLElement, value: string): void {
  const list = openSelect(combobox);
  const option = list.querySelector<HTMLElement>(`[role="option"][data-value="${CSS.escape(value)}"]`);
  if (option === null) throw new Error(`No option with value ${value}.`);
  fireEvent.click(option);
}

/** Visible names of every option, in order, without changing the value. */
export function optionNames(combobox: HTMLElement): readonly string[] {
  return listedOptions(combobox).map((option) => option.name);
}

/** Stored values of every option, in order, without changing the value. */
export function optionValues(combobox: HTMLElement): readonly string[] {
  return listedOptions(combobox).map((option) => option.value);
}

export type ListedOption = { readonly value: string; readonly name: string; readonly disabled: boolean };

/** Every option's value, visible label and disabled state, without changing the value. */
export function listedOptions(combobox: HTMLElement): readonly ListedOption[] {
  const list = openSelect(combobox);
  const options = within(list).getAllByRole('option').map((option) => ({
    value: option.dataset.value ?? '',
    name: (option.getAttribute('aria-labelledby') === null
      ? option.textContent
      : document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent ?? '').trim(),
    disabled: option.getAttribute('aria-disabled') === 'true',
  }));
  fireEvent.keyDown(combobox, { key: 'Escape' });
  return options;
}

