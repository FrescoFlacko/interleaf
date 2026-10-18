// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import {
  COMPANION_TEXT_SIZE_DEFAULT,
  COMPANION_TEXT_SIZE_MAX,
  COMPANION_TEXT_SIZE_MIN,
  DEFAULT_APP_SETTINGS,
  normalizeCompanionTextSize,
  type AppSettings,
} from '@shared/schemas/settings';
import { CompanionPanel } from '../../src/renderer/components/CompanionPanel';
import { CommandActivityItem } from '../../src/renderer/features/agent/AgentActivityItems';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * The Chat/Agent text-size preference as the companion panel applies it. The
 * preference is set in Settings → Appearance only; the tab bar carries no
 * control for it. What is asserted here is the contract the reader depends on:
 * nothing moves until they ask, and the value they chose is the value the
 * panel comes back with.
 */

let update: Mock<InterleafAPI['settings']['update']>;

/** The companion panel's own root, which carries the scale for both tabs. */
function panelScale(): string {
  const panel = screen.getByTestId('companion-panel');
  return panel.style.getPropertyValue('--companion-text-scale');
}

function settingsWith(textSize: number): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, companion: { textSize } };
}

describe('companion text size', () => {
  beforeEach(() => {
    update = vi.fn((next: AppSettings) => Promise.resolve(next));
    stubBridge({
      settings: { update },
      ai: { listProviders: vi.fn(() => Promise.resolve([])) },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([])),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useUiStore.setState({ rightTab: 'chat', settingsOpen: false });
    useUiStore.getState().hydrate(settingsWith(COMPANION_TEXT_SIZE_DEFAULT));
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ companionTextSize: COMPANION_TEXT_SIZE_DEFAULT, loadedSettings: null });
  });

  it('leaves the panel exactly as it was until the reader asks for something else', () => {
    renderWithChatStore(chat, <CompanionPanel />);

    expect(panelScale()).toBe('1');
    expect(update).not.toHaveBeenCalled();
  });

  it('comes back at the stored size after a remount', () => {
    useUiStore.getState().hydrate(settingsWith(COMPANION_TEXT_SIZE_MAX));
    const remounted = renderWithChatStore(chat, <CompanionPanel />);
    expect(panelScale()).toBe(String(COMPANION_TEXT_SIZE_MAX));

    remounted.unmount();
    useUiStore.getState().hydrate(settingsWith(COMPANION_TEXT_SIZE_MIN));
    renderWithChatStore(chat, <CompanionPanel />);
    expect(panelScale()).toBe(String(COMPANION_TEXT_SIZE_MIN));
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * A command an agent ran is readable output, but the deterministic agent
   * fixture the Electron evidence runs never reports one, so the class pair
   * that carries the preference is asserted here instead. The pair itself is
   * measured in a real browser by `tests/e2e/companion-text-size.spec.ts`,
   * which scales other content carrying exactly these classes.
   */
  it('marks an agent command and its output as readable and its sigil and status as chrome', () => {
    renderWithChatStore(chat,
      <CommandActivityItem
        activity={{ kind: 'command', id: 'cmd-1', command: 'npm run build', status: 'completed', exitCode: 0, output: 'built in 1.7s' }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByText('npm run build')).toHaveClass('companion-readable', 'companion-readable-2xs');
    expect(screen.getByLabelText('Command output')).toHaveClass('companion-readable', 'companion-readable-3xs');
    // The sigil and the status badge are marks on the line, not the line.
    expect(screen.getByText('$')).not.toHaveClass('companion-readable');
    expect(screen.getByText('Exit 0')).not.toHaveClass('companion-readable');
  });

  it('rounds a stored value to a step the schema accepts', () => {
    // Binary floating point cannot hold a multiple of 0.05 exactly, so the
    // control must not hand the schema a value a hair outside its range.
    expect(normalizeCompanionTextSize(COMPANION_TEXT_SIZE_MAX)).toBe(COMPANION_TEXT_SIZE_MAX);
    expect(normalizeCompanionTextSize(1.0700000000000003)).toBe(1.05);
    expect(normalizeCompanionTextSize(9)).toBe(COMPANION_TEXT_SIZE_MAX);
    expect(normalizeCompanionTextSize(Number.NaN)).toBe(COMPANION_TEXT_SIZE_DEFAULT);
  });
});
