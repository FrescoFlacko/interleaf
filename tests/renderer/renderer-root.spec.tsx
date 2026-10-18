// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../src/renderer/app/App', () => ({
  App: () => <div data-testid="app-shell" />,
}));

import { isBridgeInstalled } from '../../src/renderer/app/api-client';
import { RendererRoot } from '../../src/renderer/app/RendererRoot';

/**
 * The one startup check: the app mounts only with the preload bridge, and
 * otherwise the renderer shows a single static message.
 */
describe('renderer boot check', () => {
  afterEach(() => {
    cleanup();
  });

  it('detects whether preload installed the bridge', () => {
    expect(isBridgeInstalled()).toBe(true);
    expect(isBridgeInstalled({})).toBe(false);
  });

  it('mounts the app when the bridge is installed', () => {
    render(<RendererRoot bridgeInstalled />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows one static message and mounts nothing else without the bridge', () => {
    render(<RendererRoot bridgeInstalled={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Interleaf must be opened from the desktop app.');
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });
});
