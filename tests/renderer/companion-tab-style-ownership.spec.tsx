// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { CompanionPanel } from '../../src/renderer/components/CompanionPanel';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { RightTab } from '../../src/renderer/types/ui';
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

const TAB_LABELS: Record<RightTab, string> = {
  chat: 'Chat',
  search: 'Search',
  annotations: 'Annotations',
  agent: 'Agent',
};

describe('Companion tab bar style ownership', () => {
  beforeEach(() => {
    stubBridge({
      ai: { listProviders: vi.fn(() => Promise.resolve([])) },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([])),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useUiStore.setState({ rightTab: 'chat', settingsOpen: false });
  });

  afterEach(() => {
    cleanup();
  });

  /** Reads the shared tab bar's classes for the given active tab. */
  const tabBarClasses = (active: RightTab): { row: string; tablist: string; buttons: Record<RightTab, string> } => {
    fireEvent.click(screen.getByRole('tab', { name: TAB_LABELS[active] }));
    return {
      row: screen.getByRole('tablist').parentElement!.className,
      tablist: screen.getByRole('tablist').className,
      buttons: {
        chat: screen.getByRole('tab', { name: TAB_LABELS.chat }).className,
        search: screen.getByRole('tab', { name: TAB_LABELS.search }).className,
        annotations: screen.getByRole('tab', { name: TAB_LABELS.annotations }).className,
        agent: screen.getByRole('tab', { name: TAB_LABELS.agent }).className,
      },
    };
  };

  it('keeps the old shared tab classes and geometry on every tab, including Chat', () => {
    renderWithChatStore(chat, <CompanionPanel />);

    const onSearch = tabBarClasses('search');
    const onChat = tabBarClasses('chat');

    expect(onChat.tablist).toBe(onSearch.tablist);
    expect(onChat.row).toBe(onSearch.row);

    // Only the selected tab differs, and it differs identically on every tab:
    // the selected/unselected treatments do not depend on which tab is active.
    expect(onChat.buttons.chat).toBe(onSearch.buttons.search);
    expect(onChat.buttons.search).toBe(onSearch.buttons.chat);
    expect(onChat.buttons.annotations).toBe(onSearch.buttons.annotations);
    expect(onChat.buttons.agent).toBe(onSearch.buttons.agent);
    expect(onChat.buttons.chat).not.toBe(onChat.buttons.search);
  });

  it('gives the full-bleed tabs their canvas from the panel, not from tab CSS', () => {
    renderWithChatStore(chat, <CompanionPanel />);
    const content = screen.getByTestId('companion-panel-content');

    // Chat and Annotations both draw edge-to-edge — their rows, rails and
    // dividers reach the panel edge — so the panel yields its padding to them
    // and each owns its own inset internally.
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(content.className).toContain('p-0');
    expect(content.className).not.toContain('p-4');

    fireEvent.click(screen.getByRole('tab', { name: 'Annotations' }));
    expect(content.className).toContain('p-0');
    expect(content.className).not.toContain('p-4');

    // Agent joined them with the 6a/6b redesign: its header, activity feed and
    // pinned Start/Resume bars carry their own 16 px gutter, so the wrapper's
    // padding would double the tab's inset instead of setting it.
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(content.className).toContain('p-0');
    expect(content.className).not.toContain('p-4');

    // A tab without that treatment still gets the panel's own padding.
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect(content.className).toContain('p-4');
  });
});
