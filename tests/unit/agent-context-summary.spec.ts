import { describe, expect, it } from 'vitest';
import type { AgentContextPacket } from '@shared/types/agent';
import { summarizeContext } from '../../src/main/agents/agent-run-prompt';

/** The stored run summary names what was attached, not always "a passage". */
function packet(overrides: Partial<AgentContextPacket> = {}): AgentContextPacket {
  return {
    version: 1,
    document: { id: 'book', hash: 'hash', title: 'Book A', author: null },
    selection: {
      exactQuote: 'x'.repeat(44),
      anchor: { format: 'pdf', quote: { exact: 'x', prefix: '', suffix: '' }, pageIndex: 0 },
      location: { format: 'pdf', pageIndex: 0 },
      surroundingText: null,
    },
    provenance: { source: 'interleaf-reader-selection', capturedAt: '2026-10-13T00:00:00.000Z', contentIsUntrustedReference: true, truncated: false },
    ...overrides,
  };
}

describe('summarizeContext', () => {
  it('describes a selection as a selected passage', () => {
    expect(summarizeContext(packet())).toBe('Book A — selected passage (44 characters)');
  });

  it('names the attached page range, section or document scope', () => {
    expect(summarizeContext(packet({ scopeLabel: 'Pages 1–2' }))).toBe('Book A — Pages 1–2 (44 characters)');
    expect(summarizeContext(packet({
      scopeLabel: 'Entire document',
      provenance: { source: 'interleaf-reader-selection', capturedAt: '2026-10-13T00:00:00.000Z', contentIsUntrustedReference: true, truncated: true },
    }))).toBe('Book A — Entire document (first 44 characters, truncated)');
  });

  it('has no summary without context', () => {
    expect(summarizeContext(null)).toBeNull();
  });
});
