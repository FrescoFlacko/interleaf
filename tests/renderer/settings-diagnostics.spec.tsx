// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { DiagnosticsCollectResult } from '@shared/schemas/diagnostics';
import type { InterleafAPI } from '@shared/types/api';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { useDiagnosticsStore } from '../../src/renderer/stores/use-diagnostics-store';
import { stubBridge } from '../helpers/interleaf-api';
import { chooseOption } from '../helpers/listbox-select';
import { settingsModalFixture } from '../helpers/settings-modal';

/**
 * Private diagnostics in Settings › Advanced: the renderer shows exactly what
 * main collected and returned, sends nothing until the user picks a provider
 * and model and asks, and exports only through main.
 */

const HANDLE = '550e8400-e29b-41d4-a716-446655440001';

function collected(providers: DiagnosticsCollectResult['providers']): DiagnosticsCollectResult {
  const packet: DiagnosticsCollectResult['packet'] = {
    format: 'interleaf-diagnostics/1',
    collectedAt: '2026-10-25T12:00:00.000Z',
    app: { version: '0.13.0', electron: '40.1.0', chrome: '140.0.0.0', node: '22.20.0', packaging: 'packaged' },
    os: { family: 'darwin', arch: 'arm64' },
    providers: [],
    logs: { available: true, scannedRecords: 3, truncated: false, counts: [], signals: [{ code: 'import-failed', count: 1 }] },
  };
  return { handle: HANDLE, packet, packetText: JSON.stringify(packet, null, 2), providers };
}

const CLAUDE_CHOICE: DiagnosticsCollectResult['providers'] = [{ id: 'claude', models: [{ id: 'claude-default', name: 'Claude CLI default' }] }];

describe('Settings › Advanced › Private diagnostics', () => {
  const { onClose } = settingsModalFixture();
  const api = {
    collect: vi.fn<InterleafAPI['diagnostics']['collect']>(),
    preview: vi.fn<InterleafAPI['diagnostics']['preview']>(),
    analyze: vi.fn<InterleafAPI['diagnostics']['analyze']>(),
    cancel: vi.fn<InterleafAPI['diagnostics']['cancel']>(() => Promise.resolve()),
    exportReport: vi.fn<InterleafAPI['diagnostics']['exportReport']>(),
    discard: vi.fn<InterleafAPI['diagnostics']['discard']>(() => Promise.resolve()),
  };

  beforeEach(() => {
    useDiagnosticsStore.getState().discard();
    api.collect.mockResolvedValue(collected(CLAUDE_CHOICE));
    api.preview.mockImplementation((_handle, issue) => Promise.resolve({ issue: issue.replace(/\S+@\S+/u, '[email]'), report: `# Interleaf diagnostics report\n${issue.replace(/\S+@\S+/u, '[email]')}\n(Not requested.)` }));
    api.analyze.mockResolvedValue({ status: 'complete', issue: '', report: '# Interleaf diagnostics report\nObservations: import failed.' });
    api.exportReport.mockResolvedValue({ status: 'success', bytes: 42, fileName: 'Interleaf-diagnostics-report.md' });
    stubBridge({ diagnostics: api });
    vi.clearAllMocks();
  });

  async function openAdvanced(): Promise<void> {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Advanced' })).toBeEnabled(); });
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await screen.findByTestId('settings-diagnostics');
  }

  async function runAndReview(issue = ''): Promise<void> {
    fireEvent.click(screen.getByTestId('diagnostics-run'));
    await screen.findByTestId('diagnostics-packet');
    if (issue.length > 0) fireEvent.change(screen.getByTestId('diagnostics-issue'), { target: { value: issue } });
    fireEvent.click(screen.getByTestId('diagnostics-review'));
    await screen.findByTestId('diagnostics-report');
  }

  it('sits beside Export Debug Log and collects nothing until asked', async () => {
    await openAdvanced();
    expect(screen.getByRole('heading', { name: 'Private diagnostics' })).toBeTruthy();
    expect(screen.getByText(/library contents, documents, notes, chats/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export debug log/iu })).toBeTruthy();
    expect(api.collect).not.toHaveBeenCalled();
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('shows the exact packet, sanitized review and report, then analyzes only after an explicit choice', async () => {
    await openAdvanced();
    await runAndReview('Import fails, mail me at alice@example.com');
    expect(screen.getByTestId('diagnostics-packet').textContent).toBe(collected(CLAUDE_CHOICE).packetText);
    expect(api.preview).toHaveBeenCalledWith(HANDLE, 'Import fails, mail me at alice@example.com');
    expect(screen.getByTestId('diagnostics-report').textContent).toContain('[email]');
    expect(screen.getByTestId('diagnostics-report').textContent).not.toContain('alice@example.com');

    // Nothing is chosen for the user, so analysis waits.
    const analyze = screen.getByTestId('diagnostics-analyze');
    expect(analyze).toBeDisabled();
    expect(analyze.textContent).toBe('Analyze');
    chooseOption(screen.getByTestId('diagnostics-provider'), 'Claude Code');
    expect(screen.getByText(/may process and keep them under its own terms/u)).toBeTruthy();
    expect(screen.getByText(/never runs or applies anything it suggests/u)).toBeTruthy();
    expect(document.getElementById('diagnostics-analysis-disclosure')?.textContent).not.toMatch(/local address|on this device/u);
    expect(analyze).toBeDisabled();
    chooseOption(screen.getByTestId('diagnostics-model'), 'Claude CLI default');
    expect(api.analyze).not.toHaveBeenCalled();
    expect(analyze).toBeEnabled();
    expect(analyze.textContent).toMatch(/^Analyze with /u);

    fireEvent.click(analyze);
    await waitFor(() => { expect(screen.getByTestId('diagnostics-report').textContent).toContain('Observations: import failed.'); });
    expect(api.analyze).toHaveBeenCalledWith(HANDLE, 'claude', 'claude-default');
  });

  it('exports the reviewed report through main and reports the saved file name', async () => {
    await openAdvanced();
    await runAndReview();
    fireEvent.click(screen.getByTestId('diagnostics-export'));
    expect(await screen.findByText(/Saved Interleaf-diagnostics-report\.md/u)).toBeTruthy();
    expect(api.exportReport).toHaveBeenCalledWith(HANDLE);
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('says so when export is cancelled', async () => {
    api.exportReport.mockResolvedValue({ status: 'cancelled' });
    await openAdvanced();
    await runAndReview();
    fireEvent.click(screen.getByTestId('diagnostics-export'));
    expect((await screen.findByTestId('diagnostics-notice')).textContent).toBe('Export cancelled. Nothing was saved.');
  });

  it('requires a fresh review after the issue changes', async () => {
    await openAdvanced();
    await runAndReview('first');
    fireEvent.change(screen.getByTestId('diagnostics-issue'), { target: { value: 'second' } });
    expect(screen.queryByTestId('diagnostics-report')).toBeNull();
    expect(screen.queryByTestId('diagnostics-export')).toBeNull();
  });

  it('still offers export with no eligible provider and explains why', async () => {
    api.collect.mockResolvedValue(collected([]));
    await openAdvanced();
    await runAndReview();
    expect(screen.getByTestId('diagnostics-no-provider').textContent).toMatch(/retains a tool surface/u);
    expect(screen.getByTestId('diagnostics-no-provider').textContent).toMatch(/OpenRouter and local-server analysis are disabled/u);
    expect(screen.queryByTestId('diagnostics-analyze')).toBeNull();
    expect(screen.getByTestId('diagnostics-export')).toBeEnabled();
  });

  it('shows an analysis failure without provider text and keeps the reviewed report', async () => {
    api.analyze.mockResolvedValue({ status: 'failed', reason: 'timeout' });
    await openAdvanced();
    await runAndReview();
    const before = screen.getByTestId('diagnostics-report').textContent;
    chooseOption(screen.getByTestId('diagnostics-provider'), 'Claude Code');
    chooseOption(screen.getByTestId('diagnostics-model'), 'Claude CLI default');
    fireEvent.click(screen.getByTestId('diagnostics-analyze'));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/took too long/u);
    expect(screen.getByTestId('diagnostics-report').textContent).toBe(before);
  });

  it('lets the user cancel a running analysis', async () => {
    let finish = (): void => undefined;
    api.analyze.mockImplementation(() => new Promise((resolve) => { finish = () => { resolve({ status: 'failed', reason: 'cancelled' }); }; }));
    await openAdvanced();
    await runAndReview();
    chooseOption(screen.getByTestId('diagnostics-provider'), 'Claude Code');
    chooseOption(screen.getByTestId('diagnostics-model'), 'Claude CLI default');
    fireEvent.click(screen.getByTestId('diagnostics-analyze'));
    fireEvent.click(await screen.findByTestId('diagnostics-cancel'));
    expect(api.cancel).toHaveBeenCalledWith(HANDLE);
    finish();
    expect((await screen.findByTestId('diagnostics-notice')).textContent).toMatch(/Analysis cancelled/u);
  });

  it('shows main\'s message for a user-facing failure and a generic one otherwise, and allows a retry', async () => {
    api.collect.mockRejectedValueOnce(new InterleafError('validation', 'Interleaf is closing; diagnostics are unavailable.'));
    api.collect.mockRejectedValueOnce(new Error('EACCES /Users/alice/Library'));
    await openAdvanced();
    fireEvent.click(screen.getByTestId('diagnostics-run'));
    expect((await screen.findByRole('alert')).textContent).toBe('Interleaf is closing; diagnostics are unavailable.');
    fireEvent.click(screen.getByTestId('diagnostics-run'));
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Diagnostics could not complete that step. Try again.'); });
    fireEvent.click(screen.getByTestId('diagnostics-run'));
    expect(await screen.findByTestId('diagnostics-packet')).toBeTruthy();
  });

  it('discards the packet in main when Settings closes', async () => {
    await openAdvanced();
    fireEvent.click(screen.getByTestId('diagnostics-run'));
    await screen.findByTestId('diagnostics-packet');
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    await waitFor(() => { expect(api.discard).toHaveBeenCalledWith(HANDLE); });
    expect(useDiagnosticsStore.getState().collected).toBeNull();
  });
});
