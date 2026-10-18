import { describe, expect, it } from 'vitest';
import type { ChatCitation, ChatContextItem, ChatMessage } from '@shared/types/ai';
import {
  answerTerms,
  chatStarters,
  deriveChatFollowUps,
  latestAnswerState,
  precedingUserPrompt,
  retrySuggestion,
} from '../../src/renderer/features/chat/chat-follow-ups';
import { composerPlaceholder } from '../../src/renderer/features/chat/chat-labels';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm',
    sessionId: 's',
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

function contextItem(kind: ChatContextItem['kind'], displayLabel: string): ChatContextItem {
  return { id: displayLabel, kind, displayLabel } as ChatContextItem;
}

const citation: ChatCitation = { sourceId: 'S1', label: 'p. 4', pageLabel: '4', heading: 'Quorum reads' };
const input = {
  answer: '## Leader election\nA **heartbeat timeout** starts it [S1].',
  citations: [citation],
  contextItems: [] as readonly ChatContextItem[],
  documentTitle: 'Raft Paper',
};

describe('answerTerms', () => {
  it('lifts headings, bold terms and cited headings as plain, deduplicated text', () => {
    expect(answerTerms(input.answer, input.citations)).toEqual(['Leader election', 'heartbeat timeout', 'Quorum reads']);
    expect(answerTerms('**a** **Same** **same**', [])).toEqual(['Same']);
  });

  it('bounds each term and the number of terms', () => {
    const long = `**${'x'.repeat(70)}**`;
    expect(answerTerms(long, [])[0]?.length).toBe(48);
    const many = Array.from({ length: 10 }, (_, index) => `**term ${String(index)}**`).join(' ');
    expect(answerTerms(many, [])).toHaveLength(6);
  });
});

describe('chatStarters', () => {
  it('adds a context-scoped starter only for attached items other than the whole document', () => {
    expect(chatStarters('Doc', [contextItem('entire_document', 'Entire document')])).toHaveLength(3);
    const scoped = chatStarters('Doc', [contextItem('range', 'Pages 3–5')]);
    expect(scoped.at(-1)?.label).toBe('Explain the attached pages');
    expect(scoped.at(-1)?.prompt).toContain('Pages 3–5');
    expect(chatStarters('Doc', [contextItem('selection', 'Selection')]).at(-1)?.label).toBe('Explain the attached context');
  });
});

describe('deriveChatFollowUps', () => {
  it('returns one zoom-in, one zoom-out and one action suggestion, deterministically', () => {
    const first = deriveChatFollowUps(input);
    expect(first.map((suggestion) => suggestion.kind)).toEqual(['zoom-in', 'zoom-out', 'action']);
    expect(deriveChatFollowUps(input)).toEqual(first);
    expect(first[0]?.label).toBe('More on “Leader election”');
  });

  it('changes the set on every rotation step', () => {
    const labels = (rotation: number) => deriveChatFollowUps(input, rotation).map((suggestion) => suggestion.label);
    expect(labels(1)).not.toEqual(labels(0));
    expect(labels(2)).not.toEqual(labels(1));
  });

  it('falls back to grounded generic suggestions for an answer with no terms', () => {
    const plain = deriveChatFollowUps({ ...input, answer: 'Plain words.', citations: [] });
    expect(plain).toHaveLength(3);
    expect(plain[0]?.label).toBe('Go deeper');
  });
});

describe('latest answer state', () => {
  const user = message({ id: 'u', role: 'user', content: 'Explain quorum' });

  it('offers follow-ups for a settled complete answer only', () => {
    const answer = message({ id: 'a', content: 'Answer' });
    expect(latestAnswerState([user, answer], false)).toEqual({ kind: 'complete', message: answer });
    expect(latestAnswerState([user, answer], true)).toEqual({ kind: 'none' });
    expect(latestAnswerState([user, message({ status: 'streaming', content: 'Part' })], false)).toEqual({ kind: 'none' });
    expect(latestAnswerState([user], false)).toEqual({ kind: 'none' });
    expect(latestAnswerState([], false)).toEqual({ kind: 'none' });
  });

  it('offers Retry with the previous prompt after a failed or stopped answer', () => {
    expect(latestAnswerState([user, message({ status: 'failed' })], false)).toEqual({ kind: 'retry', prompt: 'Explain quorum' });
    expect(latestAnswerState([user, message({ status: 'cancelled' })], false)).toEqual({ kind: 'retry', prompt: 'Explain quorum' });
    expect(latestAnswerState([message({ status: 'failed' })], false)).toEqual({ kind: 'none' });
    expect(retrySuggestion('Explain quorum')).toMatchObject({ kind: 'retry', label: 'Retry', prompt: 'Explain quorum' });
  });

  it('finds the user prompt that preceded an answer', () => {
    const later = message({ id: 'u2', role: 'user', content: 'Second' });
    const messages = [user, message({ id: 'a1' }), later, message({ id: 'a2' })];
    expect(precedingUserPrompt(messages, 1)).toBe('Explain quorum');
    expect(precedingUserPrompt(messages, 3)).toBe('Second');
    expect(precedingUserPrompt(messages, 0)).toBeNull();
  });
});

describe('composerPlaceholder', () => {
  const ready = {
    discovery: 'succeeded' as const,
    hasReadyProvider: true,
    isArchived: false,
    sessionPlaceholder: 'Ask a question about this document…',
    hasMessages: false,
  };

  it('asks about the document before the first turn and follows up after it', () => {
    expect(composerPlaceholder(ready)).toBe('Ask about this document…');
    expect(composerPlaceholder({ ...ready, hasMessages: true })).toBe('Ask a follow up…');
  });

  it('keeps availability and passage-specific messages first', () => {
    expect(composerPlaceholder({ ...ready, hasMessages: true, hasReadyProvider: false })).toMatch(/No AI provider is ready/u);
    expect(composerPlaceholder({ ...ready, hasMessages: true, isArchived: true })).toMatch(/archived/u);
    expect(composerPlaceholder({ ...ready, discovery: 'loading' })).toBe('Checking available AI providers…');
    expect(composerPlaceholder({ ...ready, hasMessages: true, sessionPlaceholder: 'Ask about the selection…' })).toBe('Ask about the selection…');
  });
});
