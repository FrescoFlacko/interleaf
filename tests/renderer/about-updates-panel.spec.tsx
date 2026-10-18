// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AboutUpdatesPanel } from '../../src/renderer/features/chat/AboutUpdatesPanel';
import { useUpdateStore } from '../../src/renderer/stores/use-update-store';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { UpdatePhase, UpdateState } from '@shared/schemas/updates';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
import { DEVELOPMENT_UPDATE_STATE } from '../helpers/updates-api';

/**
 * About & Updates shows main's state in plain language and offers only the
 * next step main allows. Nothing downloads or restarts without a click, a
 * refused restart says what is still running, and the package-manager and
 * development installs offer only the release page.
 */

const selfUpdating = (phase: UpdatePhase): UpdateState => ({ ...DEVELOPMENT_UPDATE_STATE, support: 'self-update', phase });

let push: (state: UpdateState) => void = () => undefined;

function installBridge(initial: UpdateState, overrides: Partial<InterleafAPI['updates']> = {}): InterleafAPI['updates'] {
  const updates: InterleafAPI['updates'] = {
    getState: vi.fn(() => Promise.resolve(initial)),
    check: vi.fn(() => Promise.resolve(initial)),
    download: vi.fn(() => Promise.resolve(initial)),
    restart: vi.fn(() => Promise.resolve({ outcome: 'not-ready' as const })),
    openReleasePage: vi.fn(() => Promise.resolve({ opened: true })),
    onState: (callback) => {
      push = callback;
      return () => { push = () => undefined; };
    },
    ...overrides,
  };
  stubBridge({ updates });
  return updates;
}

function renderPanel(onChange = vi.fn()) {
  render(<AboutUpdatesPanel settings={DEFAULT_APP_SETTINGS} onChange={onChange} />);
  return onChange;
}

describe('AboutUpdatesPanel', () => {
  beforeEach(() => {
    useUpdateStore.setState({ state: null, pending: null, notice: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers only the release page to a development build and never checks', async () => {
    const updates = installBridge(DEVELOPMENT_UPDATE_STATE);
    renderPanel();
    expect(await screen.findByTestId('updates-status')).toHaveTextContent('development build');
    expect(screen.queryByTestId('updates-check')).toBeNull();
    fireEvent.click(screen.getByTestId('updates-release-page'));
    await waitFor(() => { expect(updates.openReleasePage).toHaveBeenCalledOnce(); });
    expect(updates.check).not.toHaveBeenCalled();
  });

  it('explains package-manager installs', async () => {
    installBridge({ ...DEVELOPMENT_UPDATE_STATE, support: 'package-manager' });
    renderPanel();
    expect(await screen.findByTestId('updates-status')).toHaveTextContent('system package manager');
    expect(screen.queryByTestId('updates-download')).toBeNull();
  });

  it('checks on request and offers the verified download without starting it', async () => {
    const available = selfUpdating({ status: 'available', version: '1.2.3', releaseDate: '2026-10-01T12:00:00.000Z' });
    const updates = installBridge(selfUpdating({ status: 'idle' }), { check: vi.fn(() => Promise.resolve(available)) });
    renderPanel();
    fireEvent.click(await screen.findByTestId('updates-check'));
    expect(await screen.findByTestId('updates-download')).toHaveTextContent('Download 1.2.3');
    expect(updates.download).not.toHaveBeenCalled();
    expect(screen.queryByTestId('updates-restart')).toBeNull();
  });

  it('follows pushed progress and offers a restart only once downloaded', async () => {
    installBridge(selfUpdating({ status: 'downloading', version: '1.2.3', percent: 0 }));
    renderPanel();
    await screen.findByTestId('updates-status');
    act(() => { push(selfUpdating({ status: 'downloading', version: '1.2.3', percent: 42.7 })); });
    expect(screen.getByTestId('updates-status')).toHaveTextContent('42%');
    expect(screen.getByRole('progressbar', { name: 'Update download progress' })).toHaveAttribute('value', '42.7');
    expect(screen.getByTestId('updates-check')).toBeDisabled();
    act(() => { push(selfUpdating({ status: 'downloaded', version: '1.2.3' })); });
    expect(screen.getByTestId('updates-restart')).toBeEnabled();
    expect(screen.getByTestId('updates-status')).toHaveTextContent('nothing restarts on its own');
  });

  it('says what is still running when a restart is refused', async () => {
    installBridge(selfUpdating({ status: 'downloaded', version: '1.2.3' }), {
      restart: vi.fn(() => Promise.resolve({ outcome: 'blocked' as const, activeWork: { agentSessions: 2, chatStreams: 1, imports: 0 } })),
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId('updates-restart'));
    expect(await screen.findByTestId('updates-notice')).toHaveTextContent('2 agent runs, 1 chat reply. Nothing was interrupted.');
  });

  it('offers a retry after a transfer failure but not after an integrity failure', async () => {
    installBridge(selfUpdating({ status: 'error', code: 'offline', message: 'Could not reach the release server.', version: '1.2.3' }));
    renderPanel();
    expect(await screen.findByTestId('updates-download')).toHaveTextContent('Download 1.2.3');
    act(() => {
      push(selfUpdating({ status: 'error', code: 'verification-failed', message: 'The update failed its authenticity check.', version: '1.2.3' }));
    });
    expect(screen.queryByTestId('updates-download')).toBeNull();
    expect(screen.getByTestId('updates-check')).toBeEnabled();
  });

  it('saves the automatic-check opt-out through settings', async () => {
    installBridge(DEVELOPMENT_UPDATE_STATE);
    const onChange = renderPanel();
    const toggle = await screen.findByTestId('settings-updates-automatic-checks');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_APP_SETTINGS, updates: { automaticChecks: false } });
  });

  it('reports a state request that failed and has no accessibility violations', async () => {
    installBridge(DEVELOPMENT_UPDATE_STATE, { getState: vi.fn(() => Promise.reject(new Error('ipc closed'))) });
    renderPanel();
    expect(await screen.findByTestId('updates-notice')).toHaveTextContent('did not complete');
    const results = await axe.run(document.body, { runOnly: ['wcag2a', 'wcag2aa'], rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
