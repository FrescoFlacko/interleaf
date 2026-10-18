// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import axe from 'axe-core';
import { Select, type SelectOption } from '../../src/renderer/components/ui/select';
import { chooseOption, openSelect } from '../helpers/listbox-select';

type Fruit = 'apple' | 'apricot' | 'banana' | 'cherry' | 'date';

const OPTIONS: readonly SelectOption<Fruit>[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana', disabled: true },
  { value: 'cherry', label: 'Cherry', description: 'Stone fruit' },
  { value: 'date', label: 'Date' },
];

function Harness({ onChange = vi.fn(), initial = 'apple' }: { readonly onChange?: (value: Fruit) => void; readonly initial?: Fruit }) {
  const [value, setValue] = useState<Fruit>(initial);
  return (
    <div>
      <label htmlFor="fruit">Fruit</label>
      <Select
        id="fruit"
        data-testid="fruit"
        value={value}
        options={OPTIONS}
        onValueChange={(next) => { setValue(next); onChange(next); }}
      />
      <button type="button">After</button>
    </div>
  );
}

function combobox(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Fruit' });
}

function activeOption(): string | null {
  const id = combobox().getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id)?.textContent ?? null;
}

afterEach(cleanup);

describe('Select (custom listbox)', () => {
  it('is a labelled collapsed combobox showing the current value', () => {
    render(<Harness />);
    const trigger = combobox();
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('data-value', 'apple');
    expect(trigger).toHaveTextContent('Apple');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click, marks the selection and chooses with a click', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = openSelect(combobox());
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'true');
    chooseOption(combobox(), 'Date');
    expect(onChange).toHaveBeenCalledWith('date');
    expect(combobox()).toHaveTextContent('Date');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('never chooses a disabled option', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = openSelect(combobox());
    const banana = within(list).getByRole('option', { name: 'Banana' });
    expect(banana).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(banana);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('operates fully from the keyboard and keeps focus on the trigger', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = combobox();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(activeOption()).toBe('Apple');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(activeOption()).toBe('Apricot');
    // Disabled Banana is skipped.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(activeOption()).toContain('Cherry');
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(activeOption()).toBe('Date');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(activeOption()).toBe('Date');
    fireEvent.keyDown(trigger, { key: 'Home' });
    expect(activeOption()).toBe('Apple');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('apricot');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape without changing the value or closing an enclosing dialog', () => {
    const onChange = vi.fn();
    const onDialogKey = vi.fn();
    render(<div role="dialog" aria-label="Host" onKeyDown={onDialogKey}><Harness onChange={onChange} /></div>);
    const trigger = combobox();
    fireEvent.keyDown(trigger, { key: ' ' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
    expect(onDialogKey).not.toHaveBeenCalled();
    // Closed, Escape reaches the dialog as usual.
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onDialogKey).toHaveBeenCalledOnce();
  });

  it('renders the open list inside the enclosing dialog so modal semantics hold', () => {
    render(<div role="dialog" aria-label="Host"><Harness /></div>);
    const list = openSelect(combobox());
    expect(screen.getByRole('dialog', { name: 'Host' })).toContainElement(list);
  });

  it('jumps by typeahead and cycles options sharing a first letter', () => {
    render(<Harness />);
    const trigger = combobox();
    fireEvent.keyDown(trigger, { key: 'd' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(activeOption()).toBe('Date');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(600);
      fireEvent.keyDown(trigger, { key: 'a' });
      expect(activeOption()).toBe('Apricot');
      vi.advanceTimersByTime(600);
      fireEvent.keyDown(trigger, { key: 'a' });
      expect(activeOption()).toBe('Apple');
    } finally {
      vi.useRealTimers();
    }
  });

  it('chooses the highlighted option on Tab and leaves focus traversal to the browser', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = combobox();
    openSelect(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(activeOption()).toBe('Apricot');
    // Not cancelled: the browser's own Tab then moves focus on from the trigger.
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('apricot');
    expect(trigger).toHaveAttribute('data-value', 'apricot');
    expect(trigger).toHaveTextContent('Apricot');
    // Shift+Tab chooses in the same way.
    openSelect(trigger);
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(trigger).toHaveAttribute('data-value', 'date');
  });

  it('never chooses a disabled option on Tab, and Escape cancels back to the trigger', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="apricot" />);
    const trigger = combobox();
    openSelect(trigger);
    // Hover can highlight a disabled option; Tab must not choose it.
    const banana = screen.getByRole('option', { name: 'Banana' });
    fireEvent.mouseMove(banana);
    expect(activeOption()).toBe('Banana');
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('data-value', 'apricot');
    openSelect(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('data-value', 'apricot');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes without choosing when focus leaves', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = combobox();
    openSelect(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.blur(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('respects the disabled state of an enclosing fieldset', () => {
    render(<fieldset disabled><Harness /></fieldset>);
    expect(combobox()).toBeDisabled();
  });

  it('has no axe violations closed or open', async () => {
    const { container } = render(<Harness />);
    // Contrast needs layout jsdom lacks; landmarks belong to the page, not a control.
    const rules = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };
    expect((await axe.run(container, rules)).violations).toEqual([]);
    openSelect(combobox());
    expect((await axe.run(document.body, rules)).violations).toEqual([]);
  });
});
