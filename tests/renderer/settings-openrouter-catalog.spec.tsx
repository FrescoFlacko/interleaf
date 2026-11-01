// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import type { AIModelInfo } from '@shared/types/ai';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { settingsModalFixture } from '../helpers/settings-modal';
import { chooseValue, listedOptions, optionNames } from '../helpers/listbox-select';

describe('Settings OpenRouter model discovery and selection', () => {
  const fixture = settingsModalFixture();
  const {
    listOpenRouterModels,
    configureOpenRouter,
    getSettings,
    onClose,
    onProvidersChanged,
  } = fixture;

  it('populates model dropdown from catalog, displays friendly names, and preserves current model', async () => {
    getSettings.mockResolvedValueOnce({
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, openRouterModel: 'custom/unlisted-model' },
    });
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    const select = screen.getByTestId('openrouter-model-select');
    expect(select.dataset.value).toBe('custom/unlisted-model');
    expect(listedOptions(select).find((option) => option.value === 'custom/unlisted-model')?.disabled).toBe(true);
    expect(screen.getByTestId('openrouter-model-details')).toHaveTextContent(/no longer in the current catalog/i);

    // The select carries the concise model name only; identifier, context and
    // pricing render on the separate metadata line (design 5a).
    const options = listedOptions(select).map((opt) => ({ value: opt.value, text: opt.name }));
    expect(options).toEqual(
      expect.arrayContaining([
        { value: 'openrouter/auto', text: 'OpenRouter Auto' },
        { value: 'anthropic/claude-3.5-sonnet', text: 'Anthropic: Claude 3.5 Sonnet' },
        { value: 'openai/gpt-4o', text: 'OpenAI: GPT-4o' },
        { value: 'custom/unlisted-model', text: 'Legacy/unavailable: custom/unlisted-model' },
      ])
    );
    chooseValue(select, 'openai/gpt-4o');
    expect(screen.getByTestId('openrouter-model-details')).toHaveTextContent('openai/gpt-4o');
  });

  it('renders Free, Pricing unavailable, and Pricing not published labels instead of opaque n/a/M placeholders', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('openrouter-model-select')).toBeTruthy(); });

    const select = screen.getByTestId('openrouter-model-select');
    // The metadata line renders identifier, context and pricing as separate
    // items, so read them back the way a reader sees them.
    const detailsFor = (id: string): string => {
      chooseValue(select, id);
      const line = screen.getByTestId('openrouter-model-details');
      const items = Array.from(line.querySelectorAll('span')).map((item) => item.textContent);
      return items.length > 0 ? items.join(' · ') : line.textContent;
    };

    // Zero price stays truthful and numeric: Free.
    // Both directions alike read as one phrase rather than twice.
    expect(detailsFor('demo/free-tier')).toContain('context · Free');
    // Undocumented -1 sentinel: price direction is unavailable — never
    // claimed free, never claimed unpublished-by-upstream.
    expect(detailsFor('vendor/sentinel')).toContain('Pricing unavailable');
    expect(detailsFor('openrouter/auto')).toContain('Pricing unavailable');
    expect(detailsFor('openrouter/auto')).not.toContain('input');
    // Mixed directions render independently inside one row.
    expect(detailsFor('vendor/partial')).toContain('input unavailable · output $4.00/M');
    // Missing fields and a wholly absent pricing object both read Pricing not published.
    expect(detailsFor('opaque/unpublished')).toContain('Pricing not published');
    expect(detailsFor('opaque/no-pricing-object')).toContain('Pricing not published');
    // Ordinary priced rows keep their $/M rendering next to the new labels.
    expect(detailsFor('anthropic/claude-3.5-sonnet')).toContain('200k context · input $3.00/M · output $15.00/M');
    // No artificial ceiling: documented magnitudes well past the retired
    // $1/token bound stay numeric priced rates.
    expect(detailsFor('wide/priced-large')).toContain('input $2500000.00/M · output $1000000000.00/M');
    // Tiny positive rates render enough significant digits to stay visibly
    // non-zero instead of collapsing into an exact-looking $0.0000/M.
    expect(detailsFor('sci/tiny-rate')).toContain('input $0.000001/M · output $0.000001/M');
    // Sub-fixed-precision rates fall back to scientific notation.
    expect(detailsFor('sci/sub-exponent-rate')).toContain('input $1.00e-16/M · output free');
    // Rates whose ×1,000,000 product would overflow IEEE-754 doubles derive
    // the per-million exponent without performing the multiplication.
    const nearMax = detailsFor('wide/near-max-finite');
    expect(nearMax).toContain('input $1.80e+314/M · output free');

    // No opaque n/a placeholder, rounding artifact or non-finite text survives
    // anywhere on the surface.
    const surface = document.querySelector('[data-testid="settings-content"]')?.textContent;
    for (const forbidden of ['n/a', '$0.0000/M', 'Infinity', 'NaN']) {
      expect(surface).not.toContain(forbidden);
      expect(select.textContent).not.toContain(forbidden);
    }
  });

  it('preserves a legacy model during catalog failure and blocks changed saves until retry succeeds', async () => {
    fixture.configured = true;
    getSettings.mockResolvedValueOnce({ ...DEFAULT_APP_SETTINGS, ai: { ...DEFAULT_APP_SETTINGS.ai, openRouterModel: 'legacy/provider-model' } });
    listOpenRouterModels.mockRejectedValueOnce(new Error('Network offline'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('openrouter-model-select')).toBeTruthy(); });

    const select = screen.getByTestId('openrouter-model-select');
    expect(select.dataset.value).toBe('legacy/provider-model');
    expect(listedOptions(select).find((option) => option.value === 'legacy/provider-model')?.disabled).toBe(true);
    chooseValue(select, 'openrouter/auto');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // The blocked save is named in the footer summary next to Done.
    await waitFor(() => { expect(document.getElementById('settings-error')?.textContent).toMatch(/catalog is unavailable/i); });
    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('handles catalog loading/error states with accessible retry button while keeping fallback usable', async () => {
    listOpenRouterModels.mockRejectedValueOnce(new Error('Network offline'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText('Network offline')).toBeTruthy();
    });

    const select = screen.getByTestId('openrouter-model-select');
    expect(select).toBeEnabled();
    expect(select.dataset.value).toBe('openrouter/auto');

    const retryBtn = screen.getByTestId('retry-openrouter-models-button');
    listOpenRouterModels.mockResolvedValueOnce([
      { id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 128000, maxOutputTokens: 4096, supportsStreaming: true },
      { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash', contextWindow: 1048576, maxOutputTokens: 8192, supportsStreaming: true },
    ]);
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(optionNames(select)).toContain('Google: Gemini 2.0 Flash');
    });
  });

  it('allows saving fallback selection on Done even if catalog is still loading', async () => {
    fixture.configured = true;
    // Never-resolving catalog fetch
    listOpenRouterModels.mockImplementationOnce(() => new Promise<readonly AIModelInfo[]>(() => undefined));

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    expect(screen.getByText('Loading model catalog…')).toBeTruthy();
    const select = screen.getByTestId('openrouter-model-select');
    expect(select.dataset.value).toBe('openrouter/auto');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(configureOpenRouter).toHaveBeenCalledWith({
        model: 'openrouter/auto',
      });
    });
    expect(onClose).toHaveBeenCalled();
  });
});
