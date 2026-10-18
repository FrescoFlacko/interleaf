// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { testAgentProfile } from '../helpers/agent-profile';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cssRule, mediaBlock } from './support/stylesheet-rules';

const MOTION_CSS = readFileSync(resolve(__dirname, '../../src/renderer/styles/motion.css'), 'utf8');

/**
 * The Settings dialog enters and leaves through `useSlidePresence` phases on
 * `data-phase`; motion.css turns those phases into a 200ms fade-and-scale in
 * and a 150ms fade out. jsdom cannot paint, so these tests pin the phase
 * contract and the stylesheet rules that the Electron screenshots verify.
 */

function setReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const base: Omit<MediaQueryList, 'matches'> = {
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
      return Object.assign(base, { matches: reduce && query.includes('prefers-reduced-motion') });
    },
  });
}

function renderModal(open: boolean) {
  return render(
    <AIProviderSettingsModal open={open} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="ai" />
  );
}

describe('Settings dialog motion', () => {
  beforeEach(() => {
    setReducedMotion(false);
    stubBridge({
      app: { exportDebugLog: vi.fn(() => Promise.resolve({ status: 'cancelled' as const })) },
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
        signInWithChatGPT: vi.fn(),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
        testOpenRouterConnection: vi.fn(),
      },
      settings: {
        get: vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))),
        update: vi.fn((next) => Promise.resolve(next)),
      },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([testAgentProfile('codex', 'Codex')])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('mounts in the entering phase and settles open on the next frames', async () => {
    renderModal(true);
    const scrim = screen.getByTestId('settings-dialog-scrim');
    expect(scrim.getAttribute('data-phase')).toBe('entering');
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog.classList.contains('ui-dialog')).toBe(true);
    expect(scrim.classList.contains('ui-dialog-scrim')).toBe(true);
    await waitFor(() => { expect(dialog.getAttribute('data-phase')).toBe('open'); });
    expect(scrim.getAttribute('data-phase')).toBe('open');
    expect(scrim.hasAttribute('inert')).toBe(false);
  });

  it('stays mounted, hidden and inert while exiting, then unmounts', async () => {
    const view = renderModal(true);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => { expect(dialog.getAttribute('data-phase')).toBe('open'); });

    view.rerender(
      <AIProviderSettingsModal open={false} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="ai" />
    );
    const scrim = screen.getByTestId('settings-dialog-scrim');
    expect(scrim.getAttribute('data-phase')).toBe('exiting');
    expect(scrim.getAttribute('aria-hidden')).toBe('true');
    expect(scrim.hasAttribute('inert')).toBe(true);

    await waitFor(() => { expect(screen.queryByTestId('settings-dialog-scrim')).toBeNull(); });
  });

  it('unmounts at once under reduced motion', async () => {
    setReducedMotion(true);
    const view = renderModal(true);
    await screen.findByRole('dialog', { name: 'Settings' });
    view.rerender(
      <AIProviderSettingsModal open={false} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="ai" />
    );
    expect(screen.queryByTestId('settings-dialog-scrim')).toBeNull();
  });

  it('defines a 200ms entry, a 100ms opacity-only exit and an opacity-only reduced-motion fallback', () => {
    const css = MOTION_CSS;
    expect(cssRule(css, '.ui-dialog')).toMatch(/transform var\(--dur-base\) var\(--ease-out\)/);
    expect(cssRule(css, ".ui-dialog[data-phase='entering']")).toMatch(/scale\(0\.98\)/);
    // The exit never scales: it only fades.
    expect(cssRule(css, ".ui-dialog[data-phase='exiting']")).not.toMatch(/transform|scale/);
    expect(cssRule(css, ".ui-dialog-scrim[data-phase='exiting'],\n.ui-dialog[data-phase='exiting']")).toMatch(
      /transition: opacity var\(--dur-exit\) var\(--ease-out\)/
    );
    const reduced = mediaBlock(css, '@media (prefers-reduced-motion: reduce)', '.ui-dialog');
    expect(reduced).toMatch(/\.ui-dialog,[\s\S]*transition-property: opacity/);
    expect(reduced).toMatch(/\.ui-dialog\[data-phase\] \{ transform: none; \}/);
  });
});
