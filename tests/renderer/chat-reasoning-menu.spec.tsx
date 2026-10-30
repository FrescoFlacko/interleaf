// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AIModelInfo, AIProviderStatus, ReasoningEffort } from '@shared/types/ai';
import { ChatModelPicker } from '../../src/renderer/features/chat/ChatModelPicker';
import { ChatReasoningFlyout } from '../../src/renderer/features/chat/ChatReasoningMenu';
import type { PickerRow } from '../../src/renderer/features/chat/model-picker-options';
import { isProviderReady } from '../../src/renderer/stores/chat/provider-readiness';

/**
 * The model picker's reasoning levels: a menu beside the row that only ever
 * commits when a level is chosen, and that commits the model with it.
 */

function model(id: string, name: string, levels?: readonly ReasoningEffort[]): AIModelInfo {
  return {
    id,
    name,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsStreaming: true,
    ...(levels === undefined ? {} : { reasoning: { levels: [...levels] } }),
  };
}

const capabilities = { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: true, toolFreeMode: false, hostedWebSearch: false };

const codex: AIProviderStatus = {
  id: 'codex',
  name: 'Codex CLI',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [
    model('gpt-6-sol', 'GPT-6 Sol', ['low', 'medium', 'high', 'xhigh']),
    model('gpt-6-mini', 'GPT-6 Mini', ['low', 'high']),
    model('gpt-plain', 'GPT Plain'),
  ],
  capabilities,
};

type Props = Parameters<typeof ChatModelPicker>[0];

function renderPicker(overrides: Partial<Props> = {}) {
  const onSelectModel = vi.fn();
  const providers = overrides.providers ?? [codex];
  const props: Props = {
    providers,
    readyProviders: providers.filter(isProviderReady),
    discovery: 'succeeded',
    currentProviderId: 'codex',
    currentModelId: 'gpt-6-sol',
    currentReasoningEffort: null,
    currentProviderReady: true,
    openRouterConfiguredModel: null,
    disabled: false,
    settingsOpen: false,
    onSelectModel,
    onOpenProviderSettings: vi.fn(),
    ...overrides,
  };
  render(<ChatModelPicker {...props} />);
  return { onSelectModel };
}

const trigger = (): HTMLElement => screen.getByTestId('chat-model-picker');
const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search models and providers' });
const option = (modelId: string): HTMLElement => {
  const found = screen.getAllByRole('option').find((candidate) => candidate.dataset.modelId === modelId);
  if (found === undefined) throw new Error(`no option for ${modelId}`);
  return found;
};
const menu = (): HTMLElement | null => screen.queryByRole('menu');
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

function openPicker(): void {
  fireEvent.click(trigger());
}

function setViewportWidth(value: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value });
}

beforeEach(() => { setViewportWidth(1024); });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('reasoning levels on the trigger and rows', () => {
  it('shows the saved level on the trigger and the bound row, and a chevron on rows with levels', () => {
    renderPicker({ currentReasoningEffort: 'high' });
    expect(screen.getByTestId('chat-model-trigger-effort')).toHaveTextContent('High');
    expect(trigger()).toHaveAccessibleName('AI model: GPT-6 Sol, ChatGPT, reasoning effort High');
    openPicker();
    expect(option('gpt-6-sol').querySelector('.chat-model-picker-level')).toHaveTextContent('High');
    expect(option('gpt-6-mini').querySelector('.chat-model-picker-level')).toBeNull();
    expect(option('gpt-6-sol')).toHaveAttribute('data-has-levels', 'true');
    expect(option('gpt-6-sol').querySelector('.chat-model-picker-chevron')).not.toBeNull();
    expect(option('gpt-plain')).not.toHaveAttribute('data-has-levels');
    expect(option('gpt-plain').querySelector('.chat-model-picker-chevron')).toBeNull();
    expect(option('gpt-6-sol')).toHaveAccessibleDescription('Has reasoning levels. Press Right Arrow to choose one.');
  });

  it('shows Default as no badge at all', () => {
    renderPicker();
    expect(screen.queryByTestId('chat-model-trigger-effort')).toBeNull();
  });

  it('keeps a level the model no longer offers on the trigger and marks it', () => {
    renderPicker({ currentReasoningEffort: 'max' });
    const badge = screen.getByTestId('chat-model-trigger-effort');
    expect(badge).toHaveTextContent('Max');
    expect(badge).toHaveAttribute('data-stale', 'true');
    expect(trigger()).toHaveAccessibleName('AI model: GPT-6 Sol, ChatGPT, reasoning effort Max, no longer offered by this model');
  });
});

describe('keyboard', () => {
  it('opens the levels with ArrowRight on the checked level and commits model and level with Enter', async () => {
    const { onSelectModel } = renderPicker({ currentReasoningEffort: 'medium' });
    openPicker();
    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    const levels = screen.getByRole('menu');
    expect(levels).toHaveAccessibleName('Reasoning effort for GPT-6 Sol');
    expect(within(levels).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'DefaultModel decides', 'LowFastest', 'Medium', 'HighMore thorough', 'XhighSlower',
    ]);
    expect(document.activeElement).toHaveAttribute('data-effort', 'medium');
    expect(document.activeElement).toHaveAttribute('aria-checked', 'true');
    expect(option('gpt-6-sol')).toHaveAttribute('data-expanded', 'true');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-effort', 'high');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    await flush();

    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-6-sol', 'high');
    // The levels go at once; the list follows once its exit has played.
    expect(menu()).toBeNull();
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Choose AI model' })).toBeNull(); });
    expect(document.activeElement).toBe(trigger());
  });

  it('opens a row’s levels with Enter, and checks nothing on a row that is not bound', () => {
    renderPicker({ currentReasoningEffort: 'high' });
    openPicker();
    // Rows are listed by name: GPT Plain, GPT-6 Mini, GPT-6 Sol.
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(menu()).toHaveAccessibleName('Reasoning effort for GPT-6 Mini');
    const checked = within(screen.getByRole('menu')).getAllByRole('menuitemradio').filter((item) => item.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(0);
    expect(document.activeElement).toHaveAttribute('data-effort', 'default');
  });

  it('steps back one layer at a time with Escape and ArrowLeft', async () => {
    const { onSelectModel } = renderPicker();
    openPicker();
    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Choose AI model' })).toBeInTheDocument();
    expect(document.activeElement).toBe(search());

    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(search());

    fireEvent.keyDown(search(), { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Choose AI model' })).toBeNull(); });
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('leaves ArrowRight to the caret while it is inside the query', () => {
    renderPicker();
    openPicker();
    const field = search() as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'sol' } });
    field.setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: 'ArrowRight' });
    expect(menu()).toBeNull();
  });
});

describe('levels switching to another model', () => {
  function levelRow(key: string, levels: readonly ReasoningEffort[]): PickerRow {
    return { key, providerId: 'codex', modelId: key, name: key, detail: null, unavailable: false, reasoning: { levels: [...levels] } };
  }

  /** The real flyout, rerendered from model A (checked on its high index) to a shorter model B. */
  function switchModels() {
    const picker = document.createElement('div');
    for (const id of ['row-a', 'row-b']) {
      const element = document.createElement('div');
      element.id = id;
      picker.append(element);
    }
    document.body.append(picker);
    const onChoose = vi.fn();
    const shared = {
      side: 'right' as const,
      flyoutRef: { current: null },
      pickerRef: { current: picker },
      autoFocus: true,
      onChoose,
      onBack: vi.fn(),
      onPointerEnter: vi.fn(),
      onPointerLeave: vi.fn(),
    };
    const view = render(
      <ChatReasoningFlyout {...shared} row={levelRow('a', ['low', 'medium', 'high', 'xhigh'])} checked="xhigh" rowElementId="row-a" />
    );
    expect(document.activeElement).toHaveAttribute('data-effort', 'xhigh');
    view.rerender(<ChatReasoningFlyout {...shared} row={levelRow('b', ['low', 'high'])} checked={undefined} rowElementId="row-b" />);
    return { onChoose, cleanupPicker: () => { picker.remove(); } };
  }

  it.each(['Enter', ' '])('starts the shorter model on Default and %j chooses exactly the focused level', (key) => {
    const { onChoose, cleanupPicker } = switchModels();
    const focused = document.activeElement as HTMLElement;
    expect(focused).toHaveAttribute('data-effort', 'default');
    expect(focused).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(focused, { key });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(null);
    cleanupPicker();
  });

  it('moves from the focused level of the new model, and commits what holds focus', () => {
    const { onChoose, cleanupPicker } = switchModels();
    const menuElement = screen.getByRole('menu', { name: 'Reasoning effort for b' });
    expect(within(menuElement).getAllByRole('menuitemradio').map((item) => item.dataset.effort)).toEqual(['default', 'low', 'high']);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-effort', 'low');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-effort', 'high');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-effort', 'default');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-effort', 'high');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('high');
    cleanupPicker();
  });
});

describe('pointer', () => {
  it('chooses a row without levels directly, with Default', async () => {
    const { onSelectModel } = renderPicker();
    openPicker();
    fireEvent.click(option('gpt-plain'));
    await flush();
    expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-plain', null);
    expect(menu()).toBeNull();
  });

  it('pins the levels on a click without choosing, and commits only on a level', async () => {
    const { onSelectModel } = renderPicker();
    openPicker();
    fireEvent.click(option('gpt-6-mini'));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-reasoning-flyout')).toHaveAttribute('data-side', 'right');
    // A pinned flyout ignores hover over other rows.
    vi.useFakeTimers();
    fireEvent.pointerMove(option('gpt-6-sol'), { pointerType: 'mouse', clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(1_000); });
    vi.useRealTimers();
    expect(menu()).toHaveAccessibleName('Reasoning effort for GPT-6 Mini');

    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Low/u }));
    await flush();
    expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-6-mini', 'low');
    expect(document.activeElement).toBe(trigger());
  });

  it('opens on hover after a short rest and never chooses on hover', () => {
    vi.useFakeTimers();
    const { onSelectModel } = renderPicker();
    openPicker();
    fireEvent.pointerMove(option('gpt-6-mini'), { pointerType: 'mouse', clientX: 10, clientY: 30 });
    act(() => { vi.advanceTimersByTime(40); });
    expect(menu()).toBeNull();
    act(() => { vi.advanceTimersByTime(40); });
    expect(menu()).toHaveAccessibleName('Reasoning effort for GPT-6 Mini');

    // Leaving keeps it through the grace period, then closes it.
    fireEvent.pointerLeave(screen.getByRole('listbox'));
    act(() => { vi.advanceTimersByTime(250); });
    expect(menu()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(100); });
    expect(menu()).toBeNull();
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('ignores touch hover', () => {
    vi.useFakeTimers();
    renderPicker();
    openPicker();
    fireEvent.pointerMove(option('gpt-6-mini'), { pointerType: 'touch', clientX: 10, clientY: 30 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(menu()).toBeNull();
  });
});

describe('narrow viewport', () => {
  it('opens the levels in place, under a Back row, and Back returns to the list', async () => {
    setViewportWidth(150);
    const { onSelectModel } = renderPicker({ currentReasoningEffort: 'low' });
    openPicker();
    // No room beside the list: hover does nothing.
    vi.useFakeTimers();
    fireEvent.pointerMove(option('gpt-6-mini'), { pointerType: 'mouse', clientX: 10, clientY: 30 });
    act(() => { vi.advanceTimersByTime(500); });
    vi.useRealTimers();
    expect(menu()).toBeNull();
    // Hover still moves the active row, which the keyboard then opens.
    expect(option('gpt-6-mini')).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(search(), { key: 'ArrowDown' });

    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    const nested = screen.getByTestId('chat-reasoning-nested');
    expect(screen.queryByTestId('chat-reasoning-flyout')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(search()).toHaveAttribute('aria-expanded', 'false');
    expect(within(nested).getByRole('button', { name: 'GPT-6 Sol, back to models' })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute('data-effort', 'low');

    fireEvent.click(within(nested).getByRole('button', { name: 'GPT-6 Sol, back to models' }));
    expect(screen.queryByTestId('chat-reasoning-nested')).toBeNull();
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    await flush();
    expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-6-sol', 'xhigh');
  });
});

describe('accessibility', () => {
  it('has no axe violations with the levels open beside the list', async () => {
    renderPicker({ currentReasoningEffort: 'high' });
    openPicker();
    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    expect(menu()).not.toBeNull();
    // `region` is off: the flyout is a popup layer portalled to the body, like
    // the dialog that owns it, which axe exempts only by its dialog role.
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('has no axe violations with the levels nested', async () => {
    setViewportWidth(150);
    renderPicker();
    openPicker();
    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    expect(screen.getByTestId('chat-reasoning-nested')).toBeInTheDocument();
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
