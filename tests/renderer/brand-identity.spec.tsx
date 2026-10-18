// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { APP_NAME, APP_TAGLINE } from '@shared/constants/brand';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { AppHeader } from '../../src/renderer/components/AppHeader';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { AppSettings } from '@shared/schemas/settings';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

/**
 * The visible brand surface after the Interleaf rename: the shell header mark.
 * It displays a supplied raster with an opaque light background, so it is
 * checked for the controlled light surface that keeps it readable in a dark
 * palette, and for staying decorative to assistive technology (the product
 * name is adjacent real text).
 *
 * Settings › General deliberately carries no brand card; that is asserted here
 * so the logo does not reappear in the settings surface.
 */

describe('application header brand mark', () => {
  beforeEach(() => {
    useUiStore.setState({ loadedSettings: DEFAULT_APP_SETTINGS });
  });
  afterEach(() => {
    cleanup();
  });

  it('shows the compact logo beside the product name, decorative and on its own light surface', () => {
    render(<AppHeader compact={false} />);

    expect(screen.getByTestId('app-header')).toHaveTextContent(APP_NAME);
    const mark = screen.getByTestId('app-header-logo');
    const image = mark.querySelector('img');
    expect(image?.getAttribute('src')).toMatch(/interleaf-logo/u);
    // A light tile behind the opaque raster, so a dark palette does not frame
    // the logo with a bright rectangle.
    expect(mark.className).toContain('bg-white');
    // Decorative: the readable product name is the adjacent text node.
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the product name and tagline in one baseline-aligned row', () => {
    render(<AppHeader compact={false} />);

    const name = screen.getByTestId('app-header-name');
    const tagline = screen.getByTestId('app-header-tagline');
    expect(name).toHaveTextContent(APP_NAME);
    expect(tagline).toHaveTextContent(APP_TAGLINE);
    // The two words differ in size, so centring them in the header row paints
    // the name lower than the tagline. jsdom performs no layout; where the
    // glyphs land is measured in tests/e2e/app-header-brand-alignment.spec.ts.
    const row = name.parentElement;
    expect(row).toBe(tagline.parentElement);
    expect(row?.className).toContain('items-baseline');
  });

  it('passes an accessibility audit of the brand mark', async () => {
    render(<AppHeader compact={false} />);
    // Scoped to the mark: the header's panel toggles reference shell regions
    // that only exist in the full app tree, so auditing the whole header in
    // isolation would report the harness rather than this component.
    const results = await axe.run(screen.getByTestId('app-header-logo'), {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

describe('Settings General carries no brand card', () => {
  const exportDebugLog = vi.fn(() => Promise.resolve({ status: 'cancelled' as const }));
  const getSettings = vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS)));

  beforeEach(() => {
    vi.clearAllMocks();
    stubBridge({
      app: { exportDebugLog },
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
      },
      settings: { get: getSettings, update: vi.fn((next: AppSettings) => Promise.resolve(next)) },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
    });
  });
  afterEach(() => {
    cleanup();
  });

  async function openGeneral(): Promise<HTMLElement> {
    const { container } = render(
      <AIProviderSettingsModal open={true} onClose={vi.fn()} initialTarget="general" onProvidersChanged={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    });
    return container;
  }

  it('shows the General section without any logo or wordmark artwork', async () => {
    const container = await openGeneral();

    expect(screen.queryByTestId('settings-general-about')).toBeNull();
    const section = container.querySelector('section[aria-labelledby="settings-general-heading"]');
    expect(section).not.toBeNull();
    expect(section?.querySelectorAll('img')).toHaveLength(0);
  });

  it('passes an accessibility audit', async () => {
    const container = await openGeneral();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
