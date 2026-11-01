// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { settingsModalFixture } from '../helpers/settings-modal';

describe('Settings diagnostics export', () => {
  const {
    exportDebugLog,
    onClose,
  } = settingsModalFixture();

  it('reports successful and cancelled native debug-log export outcomes accessibly', async () => {
    exportDebugLog.mockResolvedValueOnce({ status: 'success', bytes: 123, fileName: 'Interleaf-debug-log.jsonl' });
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('export-debug-log-button')).toBeEnabled(); });
    fireEvent.click(screen.getByTestId('export-debug-log-button'));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Debug log exported successfully');
      expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    });

    exportDebugLog.mockResolvedValueOnce({ status: 'cancelled' });
    fireEvent.click(screen.getByTestId('export-debug-log-button'));
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Debug log export cancelled'); });
  });

  it('reports debug-log export failures without exposing a destination path', async () => {
    exportDebugLog.mockRejectedValueOnce(new Error('export failed: /Users/alice/private.log'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('export-debug-log-button')).toBeEnabled(); });
    fireEvent.click(screen.getByTestId('export-debug-log-button'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('export failed');
      expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('/Users/alice/private.log');
  });
});
