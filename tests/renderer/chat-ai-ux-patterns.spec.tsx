// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ChatContextItem, ChatMessage, ChatSession } from '@shared/types/ai';
import { ChatEmptyThread } from '../../src/renderer/features/chat/ChatEmptyThread';
import { ChatFollowUps } from '../../src/renderer/features/chat/ChatFollowUps';
import { ChatPromptDetails } from '../../src/renderer/features/chat/ChatPromptDetails';
import { ChatThread } from '../../src/renderer/features/chat/ChatThread';
import { promptDetailTokens } from '../../src/renderer/features/chat/chat-prompt-details';
import { useComposerFill } from '../../src/renderer/features/chat/use-composer-fill';
import { stubBridge } from '../helpers/interleaf-api';

const writeText = vi.fn((text: string) => Promise.resolve({ copied: true as const, characterCount: text.length }));

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm',
    sessionId: 'session-1',
    role: 'assistant',
    ordinal: 0,
    content: '',
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: 0,
    errorMessage: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    disclosures: [],
    webSources: [],
    ...overrides,
  };
}

const session = { id: 'session-1', providerId: 'openrouter', modelId: 'openrouter/auto', isArchived: false, title: 'Chat' } as ChatSession;
const user = message({ id: 'u1', role: 'user', content: 'Explain **quorum** reads' });
const answer = message({
  id: 'a1',
  ordinal: 1,
  content: '## Quorum\nA **majority** must agree [S1].',
  citations: [{ sourceId: 'S1', label: 'p. 2', pageLabel: '2', heading: null }],
});

/** A composer and one fill source, wired the way ChatPanel wires them. */
function FillHarness({ onSubmit }: { readonly onSubmit: () => void }) {
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fill = useComposerFill(composerRef, setDraft);
  return (
    <>
      <ChatEmptyThread messageCount={0} isLoading={false} documentTitle="Raft Paper" startersAvailable onStarter={fill} contextItems={[]} />
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <textarea aria-label="Message Reader AI" ref={composerRef} value={draft} onChange={(event) => { setDraft(event.target.value); }} />
      </form>
    </>
  );
}

beforeEach(() => {
  writeText.mockClear();
  stubBridge({ clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
});

describe('empty thread starters', () => {
  it('offers starters without repeating the document name, and fills and focuses the composer without sending', async () => {
    const onSubmit = vi.fn();
    render(<FillHarness onSubmit={onSubmit} />);

    // The reader already shows the document's name; the empty state does not repeat it.
    expect(screen.queryByTestId('chat-empty-document-title')).toBeNull();
    expect(screen.getByTestId('chat-empty-thread')).not.toHaveTextContent('Raft Paper');
    const starters = within(screen.getByRole('group', { name: 'Starter prompts' })).getAllByRole('button');
    expect(starters.map((button) => button.textContent)).toEqual([
      'Summarize this document',
      'Explain the key ideas',
      'Outline the argument',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Summarize this document' }));
    const composer = screen.getByLabelText('Message Reader AI');
    expect(composer).toHaveValue('Summarize “Raft Paper” in a few short paragraphs, citing the pages you draw on.');
    await waitFor(() => { expect(document.activeElement).toBe(composer); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('adds a context-scoped starter and hides starters while the composer is unavailable', () => {
    const range = { id: 'r', kind: 'range', displayLabel: 'Pages 3–5' } as ChatContextItem;
    const { rerender } = render(
      <ChatEmptyThread messageCount={0} isLoading={false} documentTitle="Doc" contextItems={[range]} startersAvailable onStarter={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Explain the attached pages' })).toBeTruthy();

    rerender(<ChatEmptyThread messageCount={0} isLoading={false} documentTitle="Doc" startersAvailable={false} onStarter={vi.fn()} contextItems={[]} />);
    expect(screen.queryByTestId('chat-starters')).toBeNull();
    expect(screen.getByTestId('chat-empty-thread')).toBeTruthy();
  });
});

describe('Prompt details', () => {
  const tokens = promptDetailTokens(answer, session, undefined);

  it('lists only the parameters the app holds', () => {
    expect(tokens).toEqual([
      { label: 'Provider', value: 'OpenRouter' },
      { label: 'Model', value: 'openrouter/auto' },
      { label: 'Cited sources', value: '1' },
    ]);
    const web = message({ webSources: [{ url: 'https://example.com', title: 'Example' }] });
    expect(promptDetailTokens(web, null, undefined)).toEqual([
      { label: 'Cited sources', value: '0' },
      { label: 'Web sources', value: '1' },
    ]);
  });

  it('is collapsed, shows the prompt as text when expanded, and copies or reuses it', async () => {
    const onReuse = vi.fn();
    const onNotice = vi.fn();
    const { container } = render(
      <ChatPromptDetails prompt="<img src=x onerror=alert(1)> Explain" tokens={tokens} reuseAvailable onReuse={onReuse} onNotice={onNotice} />
    );
    const toggle = screen.getByRole('button', { name: /prompt details/iu });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('chat-prompt-details-text')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const text = screen.getByTestId('chat-prompt-details-text');
    expect(text).toBeVisible();
    expect(text.textContent).toBe('<img src=x onerror=alert(1)> Explain');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Answer parameters').textContent).toBe('ProviderOpenRouterModelopenrouter/autoCited sources1');
    expect(screen.getByText(/Which context a past turn used is not recorded/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => { expect(onNotice).toHaveBeenCalledWith('success', 'Prompt copied'); });
    expect(writeText).toHaveBeenCalledWith('<img src=x onerror=alert(1)> Explain');

    fireEvent.click(screen.getByRole('button', { name: 'Reuse prompt' }));
    expect(onReuse).toHaveBeenCalledWith('<img src=x onerror=alert(1)> Explain');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('disables Reuse prompt while the composer is unavailable', () => {
    render(<ChatPromptDetails prompt="Explain" tokens={[]} reuseAvailable={false} onReuse={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /prompt details/iu }));
    expect(screen.getByRole('button', { name: 'Reuse prompt' })).toBeDisabled();
  });
});

describe('Suggested follow-ups', () => {
  const complete = { kind: 'complete' as const, message: answer };

  it('offers at most three chips that fill the composer, and rotates them', async () => {
    const onFill = vi.fn();
    const { container } = render(
      <ChatFollowUps latest={complete} contextItems={[]} documentTitle="Raft Paper" available onFill={onFill} />
    );
    const group = screen.getByRole('group', { name: 'Suggested follow-ups' });
    const chips = () => Array.from(group.querySelectorAll<HTMLButtonElement>('.companion-follow-up'));
    expect(chips()).toHaveLength(3);
    expect(chips().map((chip) => chip.dataset.kind)).toEqual(['zoom-in', 'zoom-out', 'action']);

    const before = chips().map((chip) => chip.textContent);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh suggestions' }));
    expect(chips().map((chip) => chip.textContent)).not.toEqual(before);

    fireEvent.click(chips()[0]!);
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onFill.mock.calls[0]?.[0]).toMatch(/your last answer/u);

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('offers Retry with the previous prompt, and nothing when unavailable or unsettled', () => {
    const onFill = vi.fn();
    const { rerender } = render(
      <ChatFollowUps latest={{ kind: 'retry', prompt: 'Explain quorum' }} contextItems={[]} documentTitle="Doc" available onFill={onFill} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onFill).toHaveBeenCalledWith('Explain quorum');

    rerender(<ChatFollowUps latest={complete} contextItems={[]} documentTitle="Doc" available={false} onFill={onFill} />);
    expect(screen.queryByTestId('chat-follow-ups')).toBeNull();
    rerender(<ChatFollowUps latest={{ kind: 'none' }} contextItems={[]} documentTitle="Doc" available onFill={onFill} />);
    expect(screen.queryByTestId('chat-follow-ups')).toBeNull();
  });
});

describe('ChatThread', () => {
  function renderThread(messages: readonly ChatMessage[], isStreaming: boolean) {
    return render(
      <ChatThread
        messages={messages}
        visibleMessages={messages}
        isStreaming={isStreaming}
        activeSessionId="session-1"
        session={session}
        sessionProvider={undefined}
        contextItems={[]}
        documentTitle="Raft Paper"
        composerAvailable
        canSaveNote={false}
        onSaveNote={() => Promise.resolve(false)}
        onNotice={vi.fn()}
        goToLocation={() => Promise.resolve()}
        onFill={vi.fn()}
      />
    );
  }

  it('puts Prompt details on the completed answer and follow-ups under the latest one', () => {
    renderThread([user, answer], false);
    const article = screen.getByRole('article', { name: 'Reader AI response' });
    fireEvent.click(within(article).getByRole('button', { name: /prompt details/iu }));
    expect(within(article).getByTestId('chat-prompt-details-text')).toHaveTextContent('Explain **quorum** reads');
    expect(screen.getByRole('group', { name: 'Suggested follow-ups' })).toBeTruthy();
  });

  it('hides follow-ups and prompt details while an answer streams', () => {
    renderThread([user, message({ id: 'a2', status: 'streaming', content: 'Partial' })], true);
    expect(screen.queryByTestId('chat-follow-ups')).toBeNull();
    expect(screen.queryByTestId('chat-prompt-details')).toBeNull();
  });
});
