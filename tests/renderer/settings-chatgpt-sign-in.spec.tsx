// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import type { AIProviderStatus } from '@shared/types/ai';
import type { AppSettings } from '@shared/schemas/settings';
import { codexProvider, expandProvider, settingsModalFixture } from '../helpers/settings-modal';

describe('Settings ChatGPT sign-in and provider status freshness', () => {
  const {
    listProviders,
    signInWithChatGPT,
    getSettings,
    onClose,
    onProvidersChanged,
  } = settingsModalFixture();

  it('offers a main-owned ChatGPT sign-in action for Reader Chat', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    const button = await screen.findByTestId('sign-in-chatgpt-button');
    expect(button).toHaveTextContent('Sign in with ChatGPT');
    fireEvent.click(button);
    await waitFor(() => { expect(signInWithChatGPT).toHaveBeenCalledOnce(); });
    expect(await screen.findByText(/Signed in with ChatGPT\. Your subscription is now available/u)).toBeTruthy();
    expect(onProvidersChanged).toHaveBeenCalledOnce();
  });

  it('renders the sign-in action as a primary button that spins while the browser flow is pending', async () => {
    let resolveSignIn!: (provider: AIProviderStatus) => void;
    signInWithChatGPT.mockImplementationOnce(() => new Promise<AIProviderStatus>((resolve) => { resolveSignIn = resolve; }));

    const { container } = render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    const button = await screen.findByTestId('sign-in-chatgpt-button');

    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    // Idle: exact copy, enabled, not busy, and no spinner.
    expect(button).toHaveTextContent('Sign in with ChatGPT');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByTestId('sign-in-chatgpt-spinner')).toBeNull();
    // The live region is present and empty before activation, so its later
    // text is a change inside an existing region rather than a new node.
    const idleStatus = screen.getByTestId('chatgpt-sign-in-pending-status');
    expect(idleStatus).toHaveAttribute('role', 'status');
    expect(idleStatus).toHaveAttribute('aria-live', 'polite');
    expect(idleStatus).toHaveTextContent('');

    fireEvent.click(button);
    await waitFor(() => { expect(signInWithChatGPT).toHaveBeenCalledOnce(); });

    // Pending: duplicate activation is refused, the state is exposed, and a
    // visible spinner runs beside an accessible waiting status.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(signInWithChatGPT).toHaveBeenCalledOnce();
    const spinner = screen.getByTestId('sign-in-chatgpt-spinner');
    expect(spinner.getAttribute('class')).toContain('animate-spin');
    // Respect a reader who has asked the system for less motion.
    expect(spinner.getAttribute('class')).toContain('motion-reduce:animate-none');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    // The same node the reader was already given now carries the instruction.
    const status = screen.getByTestId('chatgpt-sign-in-pending-status');
    expect(status).toBe(idleStatus);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/ChatGPT sign-in page/u);
    expect(button).toHaveTextContent('Opening ChatGPT sign-in…');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);

    resolveSignIn(codexProvider);
    await waitFor(() => { expect(screen.getByTestId('sign-in-chatgpt-button')).toBeEnabled(); });
    expect(screen.queryByTestId('sign-in-chatgpt-spinner')).toBeNull();
    // The region stays mounted and simply falls silent once the flow finishes.
    const settledStatus = screen.getByTestId('chatgpt-sign-in-pending-status');
    expect(settledStatus).toBe(idleStatus);
    expect(settledStatus).toHaveTextContent('');
  });

  it('holds the connected sign-in result and starts no competing status probe', async () => {
    let resolveSignIn!: (provider: AIProviderStatus) => void;
    const signInPromise = new Promise<AIProviderStatus>((resolve) => {
      resolveSignIn = resolve;
    });

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    expect(screen.getByTestId('sign-in-chatgpt-button')).toBeEnabled();

    signInWithChatGPT.mockImplementationOnce(() => signInPromise);
    fireEvent.click(screen.getByTestId('sign-in-chatgpt-button'));
    await waitFor(() => { expect(signInWithChatGPT).toHaveBeenCalledOnce(); });
    const providerProbeCalls = listProviders.mock.calls.length;
    expect(screen.getByTestId('sign-in-chatgpt-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('sign-in-chatgpt-button'));
    expect(signInWithChatGPT).toHaveBeenCalledOnce();
    expect(listProviders).toHaveBeenCalledTimes(providerProbeCalls);

    resolveSignIn(codexProvider);
    await waitFor(() => {
      expect(screen.getByTestId('codex-chatgpt-auth-status')).toHaveTextContent('Ready');
    });
  });

  it('propagates sign-in completion to a newly mounted Settings modal', async () => {
    let resolveSignIn!: (provider: AIProviderStatus) => void;
    const signInPromise = new Promise<AIProviderStatus>((resolve) => {
      resolveSignIn = resolve;
    });
    signInWithChatGPT.mockImplementationOnce(() => signInPromise);

    const first = render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    expect(screen.getByTestId('sign-in-chatgpt-button')).toBeEnabled();
    fireEvent.click(screen.getByTestId('sign-in-chatgpt-button'));
    await waitFor(() => { expect(signInWithChatGPT).toHaveBeenCalledOnce(); });

    // The original modal can disappear while the provider-owned browser flow
    // is active. The replacement initially observes the stale probe result.
    first.unmount();
    listProviders.mockImplementation(() => Promise.resolve([{ ...codexProvider, authentication: 'disconnected' }]));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    await waitFor(() => { expect(screen.getByTestId('codex-chatgpt-auth-status')).toHaveTextContent('Sign-in required'); });

    resolveSignIn(codexProvider);
    await waitFor(() => {
      expect(screen.getByTestId('codex-chatgpt-auth-status')).toHaveTextContent('Ready');
    });
  });

  it('shows a current dependency failure after remount sign-in freshness changes', async () => {
    let resolveSignIn!: (provider: AIProviderStatus) => void;
    const signInPromise = new Promise<AIProviderStatus>((resolve) => {
      resolveSignIn = resolve;
    });
    let rejectSettings!: (error: Error) => void;
    const settingsPromise = new Promise<AppSettings>((_resolve, reject) => {
      rejectSettings = reject;
    });
    signInWithChatGPT.mockImplementationOnce(() => signInPromise);

    const first = render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await expandProvider('codex');
    expect(screen.getByTestId('sign-in-chatgpt-button')).toBeEnabled();
    fireEvent.click(screen.getByTestId('sign-in-chatgpt-button'));
    await waitFor(() => { expect(signInWithChatGPT).toHaveBeenCalledOnce(); });
    first.unmount();

    listProviders.mockImplementationOnce(() => Promise.resolve([{ ...codexProvider, authentication: 'disconnected' }]));
    getSettings.mockImplementationOnce(() => settingsPromise);
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    resolveSignIn(codexProvider);
    rejectSettings(new Error('current settings read failed'));

    await waitFor(() => {
      expect(screen.getByTestId('settings-load-error')).toHaveTextContent('current settings read failed');
      expect(screen.getByRole('button', { name: 'Retry loading settings' })).toBeTruthy();
    });
  });
});
