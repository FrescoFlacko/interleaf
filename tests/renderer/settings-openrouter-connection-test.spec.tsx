// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { settingsModalFixture } from '../helpers/settings-modal';

describe('Settings OpenRouter connection test', () => {
  const fixture = settingsModalFixture();
  const {
    testOpenRouterConnection,
    onClose,
  } = fixture;

  async function runConnectionTest(): Promise<HTMLElement> {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    fireEvent.click(await screen.findByTestId('test-openrouter-button'));
    return screen.findByTestId('openrouter-test-result');
  }

  it('reports a failed connection test from main', async () => {
    testOpenRouterConnection.mockResolvedValueOnce({ success: false, message: 'OpenRouter rejected the key.' });

    const result = await runConnectionTest();

    expect(result).toHaveTextContent('OpenRouter rejected the key.');
    expect(result).toHaveClass('text-danger');
    expect(screen.getByTestId('test-openrouter-button')).toHaveTextContent('Test connection');
  });

  it('reports a connection test that could not reach main', async () => {
    testOpenRouterConnection.mockRejectedValueOnce(new Error('IPC channel closed'));

    const result = await runConnectionTest();

    expect(result).toHaveTextContent('IPC channel closed');
    expect(result).toHaveClass('text-danger');
  });

  it('tests connection via main process without exposing keys', async () => {
    const result = await runConnectionTest();

    // The renderer hands main nothing: the stored key never crosses the bridge.
    expect(testOpenRouterConnection).toHaveBeenCalledWith();
    expect(result).toHaveTextContent(/Connected successfully to OpenRouter/i);
  });
});
