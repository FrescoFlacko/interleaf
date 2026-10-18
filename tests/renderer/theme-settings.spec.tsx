// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import axe from 'axe-core';
import { PALETTES } from '@shared/constants/palettes';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { ThemeSettingsSection } from '../../src/renderer/features/theme/ThemeSettingsSection';
import { ThemeMenu } from '../../src/renderer/features/theme/ThemeMenu';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { chooseOption } from '../helpers/listbox-select';

function SectionHarness({ onChange }: { readonly onChange: (next: AppSettings) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  return <ThemeSettingsSection settings={settings} onChange={(next) => { setSettings(next); onChange(next); }} />;
}

function radio(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: new RegExp(`^${name}`) });
}

afterEach(cleanup);

describe('Settings → Theme', () => {
  it('offers every theme as one radio in a labelled group, with the current one checked and tabbable', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio');
    expect(radios).toHaveLength(PALETTES.length);
    const checked = radios.filter((element) => element.getAttribute('aria-checked') === 'true');
    expect(checked.map((element) => element.dataset.palette)).toEqual([DEFAULT_APP_SETTINGS.appearance.palette]);
    expect(radios.filter((element) => element.tabIndex === 0)).toEqual(checked);
  });

  it('describes each card with its mood', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const nocturne = PALETTES.find((info) => info.id === 'nocturne');
    expect(radio('Nocturne')).toHaveAccessibleDescription(nocturne?.mood ?? '');
  });

  it('chooses a theme on click, applies it and remembers the previous one as recent', () => {
    const onChange = vi.fn();
    render(<SectionHarness onChange={onChange} />);
    fireEvent.click(radio('Nocturne'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      appearance: { palette: 'nocturne', recentPalettes: expect.arrayContaining([DEFAULT_APP_SETTINGS.appearance.palette]) as string[] },
    }));
    expect(useUiStore.getState().palette).toBe('nocturne');
    expect(radio('Nocturne')).toHaveAttribute('aria-checked', 'true');
  });

  it('moves and chooses with arrow keys, Home and End, wrapping at the ends', () => {
    const onChange = vi.fn();
    render(<SectionHarness onChange={onChange} />);
    const first = PALETTES[0];
    const last = PALETTES[PALETTES.length - 1];
    fireEvent.keyDown(screen.getByRole('radio', { checked: true }), { key: 'Home' });
    expect(document.activeElement).toHaveAttribute('data-palette', first?.id);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowLeft' });
    expect(document.activeElement).toHaveAttribute('data-palette', last?.id);
    expect(document.activeElement).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-palette', first?.id);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: expect.objectContaining({ palette: last?.id }) as object }));
  });

  it('sets the reader page background through the listbox select', () => {
    const onChange = vi.fn();
    render(<SectionHarness onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Reader page background' });
    chooseOption(select, 'Sepia');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reader: expect.objectContaining({ background: 'sepia' }) as object }));
    expect(select).toHaveAttribute('data-value', 'sepia');
  });

  it('groups the cards under Light and Dark with counts, in the order the arrow keys walk', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const light = screen.getByTestId('theme-group-light');
    const dark = screen.getByTestId('theme-group-dark');
    const lightCount = PALETTES.filter((info) => info.appearance === 'light').length;
    const darkCount = PALETTES.length - lightCount;
    expect(light).toHaveTextContent(new RegExp(`^Light${String(lightCount)}`));
    expect(dark).toHaveTextContent(new RegExp(`^Dark${String(darkCount)}`));
    expect(within(light).getAllByRole('radio')).toHaveLength(lightCount);
    expect(within(dark).getAllByRole('radio')).toHaveLength(darkCount);
    const order = screen.getAllByRole('radio').map((element) => element.dataset.palette);
    expect(order).toEqual(PALETTES.map((info) => info.id));
  });

  it('names each group for assistive technology, inside the one Theme radio group', async () => {
    const { container } = render(<SectionHarness onChange={vi.fn()} />);
    const theme = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(theme).getByRole('group', { name: 'Light' })).toBe(screen.getByTestId('theme-group-light'));
    expect(within(theme).getByRole('group', { name: 'Dark' })).toBe(screen.getByTestId('theme-group-dark'));
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('shows a concise name under its heading while the radio keeps the full one', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const card = screen.getByTestId('theme-option-contrast-dark');
    expect(card).toHaveAccessibleName('High Contrast Dark');
    expect(card).toHaveAttribute('title', 'High Contrast Dark');
    expect(card.querySelector('.truncate')).toHaveTextContent(/^High Contrast$/);
  });

  it('marks only the checked card with a check badge', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const badges = screen.getAllByTestId('theme-option-check');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest('[role="radio"]')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio('Nocturne'));
    expect(screen.getAllByTestId('theme-option-check')).toHaveLength(1);
    expect(within(radio('Nocturne')).getByTestId('theme-option-check')).toBeTruthy();
  });

  it('scrolls the checked card into view when the section opens', () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ThemeSettingsSection settings={{ ...DEFAULT_APP_SETTINGS, appearance: { ...DEFAULT_APP_SETTINGS.appearance, palette: 'umber' } }} onChange={vi.fn()} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId('theme-option-umber'));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('centres a checked card that had to be revealed, under its sticky group label', () => {
    // The fake scroll moves the card, as a real reveal from below the fold does.
    let scrolled = 0;
    const scrollIntoView = vi.fn(() => { scrolled += 1; });
    const originalScroll = Element.prototype.scrollIntoView;
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, scrolled === 0 ? 900 : 400, 100, 80));
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ThemeSettingsSection settings={{ ...DEFAULT_APP_SETTINGS, appearance: { ...DEFAULT_APP_SETTINGS.appearance, palette: 'umber' } }} onChange={vi.fn()} />);
      expect(scrollIntoView.mock.calls).toEqual([[{ block: 'nearest' }], [{ block: 'center' }]]);
      expect(screen.getByTestId('theme-group-dark-heading').className).toContain('sticky');
      expect(screen.getByTestId('theme-group-light-heading').className).toContain('sticky');
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      rect.mockRestore();
    }
  });

  it('draws each theme’s swatch beside it in the reader background list', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Reader page background' }));
    const sepia = screen.getByRole('option', { name: /^Sepia/ });
    expect(sepia.querySelector('svg circle')).not.toBeNull();
    expect(screen.getByRole('option', { name: /^Match app theme/ }).querySelector('svg circle')).toBeNull();
  });

  it('does not claim to recolour document images or pinned diagrams', () => {
    render(<SectionHarness onChange={vi.fn()} />);
    const heading = screen.getByRole('heading', { name: 'Theme' });
    const section = heading.closest('section');
    expect(section).not.toHaveTextContent(/every colour in the app/);
    expect(section).toHaveTextContent(/document’s own images/);
  });

  it('has no axe violations', async () => {
    const { container } = render(<SectionHarness onChange={vi.fn()} />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('header theme menu', () => {
  function renderMenu(appearance: AppSettings['appearance'] = { palette: 'sepia' }) {
    const onChoose = vi.fn();
    const onAllThemes = vi.fn();
    render(<ThemeMenu appearance={appearance} disabled={false} onChoose={onChoose} onAllThemes={onAllThemes} />);
    return { onChoose, onAllThemes, trigger: screen.getByRole('button', { name: 'Theme: Sepia' }) };
  }

  it('lists the current theme, the recent ones and "All themes…"', () => {
    const { trigger } = renderMenu({ palette: 'sepia', recentPalettes: ['nocturne', 'paper'] });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Theme' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Sepia', 'Nocturne', 'Paper']);
    expect(within(menu).getByRole('menuitemradio', { name: 'Sepia' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toHaveTextContent('Sepia');
    expect(within(menu).getByRole('menuitem', { name: 'All themes…' })).toBeVisible();
  });

  it('chooses with the keyboard and returns focus to the trigger', () => {
    const { trigger, onChoose } = renderMenu({ palette: 'sepia', recentPalettes: ['nocturne'] });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Nocturne');
    fireEvent.click(document.activeElement ?? document.body);
    expect(onChoose).toHaveBeenCalledWith('nocturne');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape and opens all themes from the last item', () => {
    const { trigger, onAllThemes } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'End' });
    fireEvent.click(document.activeElement ?? document.body);
    expect(onAllThemes).toHaveBeenCalledTimes(1);
  });
});
