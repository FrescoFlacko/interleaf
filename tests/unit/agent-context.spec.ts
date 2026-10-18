import { describe, expect, it } from 'vitest';
import { fitAgentContextPacketToByteBudget, takeCodePointPrefix, takeCodePointSuffix } from '@shared/agent-context';
import { AGENT_MAX_CONTEXT_PACKET_BYTES } from '@shared/schemas/agent';
import type { AgentContextPacket } from '@shared/types/agent';

function packet(
  exactQuote: string,
  surroundingText: string | null,
  anchor: AgentContextPacket['selection']['anchor'] = {
    format: 'markdown',
    blockIndex: 3,
    quote: { exact: '', prefix: '', suffix: '' },
  },
): AgentContextPacket {
  return {
    version: 1,
    document: { id: 'agent-context-test', hash: 'agent-context-test-hash', title: 'Context test', author: null },
    selection: {
      exactQuote,
      anchor,
      location: { format: 'markdown', blockIndex: 3 },
      surroundingText,
    },
    provenance: {
      source: 'interleaf-reader-selection',
      capturedAt: '2026-08-27T18:00:00.000Z',
      contentIsUntrustedReference: true,
      truncated: false,
    },
  };
}

function byteLength(value: AgentContextPacket): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe('Agent context packet byte normalizer', () => {
  it('returns an ordinary under-budget packet unchanged, including its exact anchor', () => {
    const input = packet('ordinary selection', 'useful surrounding text', {
      format: 'markdown',
      blockIndex: 3,
      lineIndex: 4,
      quote: { exact: 'ordinary selection', prefix: 'before', suffix: 'after' },
    });

    const result = fitAgentContextPacketToByteBudget(input, false);

    expect(result).toBe(input);
    expect(result.selection.anchor.quote).toEqual(input.selection.anchor.quote);
    expect(result.selection.surroundingText).toBe('useful surrounding text');
  });

  it('drops optional surrounding text before trimming an oversized exact quote', () => {
    const surroundingText = 'surrounding '.repeat(1_600);
    const input = packet('X'.repeat(250_000), surroundingText);

    const result = fitAgentContextPacketToByteBudget(input, false);

    expect(result.selection.exactQuote).toHaveLength(250_000);
    expect(result.selection.surroundingText?.length ?? 0).toBeLessThan(surroundingText.length);
    expect(result.provenance.truncated).toBe(false);
    expect(byteLength(result)).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
  });

  it('fits non-BMP text at a code-point boundary and uses the available byte budget', () => {
    const input = packet('😀'.repeat(125_000), null);

    const result = fitAgentContextPacketToByteBudget(input, false);
    const nextCodePoint = {
      ...result,
      selection: { ...result.selection, exactQuote: `${result.selection.exactQuote}😀` },
    };

    expect(result.selection.exactQuote.length % 2).toBe(0);
    expect(result.selection.exactQuote).not.toContain('\uFFFD');
    expect(byteLength(result)).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
    expect(byteLength(nextCodePoint)).toBeGreaterThan(AGENT_MAX_CONTEXT_PACKET_BYTES);
    expect(result.provenance.truncated).toBe(true);
  });

  it('keeps character-limit prefixes and suffixes on complete Unicode code points', () => {
    const prefixBoundary = `${'A'.repeat(19_999)}😀`;
    const exactBoundary = `${'A'.repeat(19_998)}😀`;

    expect(takeCodePointPrefix(prefixBoundary, 20_000)).toBe('A'.repeat(19_999));
    expect(takeCodePointPrefix(exactBoundary, 20_000)).toBe(exactBoundary);
    expect(takeCodePointSuffix(`😀${'B'.repeat(19_999)}`, 20_000)).toBe('B'.repeat(19_999));
    expect(takeCodePointSuffix(`😀${'B'.repeat(19_998)}`, 20_000)).toBe(`😀${'B'.repeat(19_998)}`);
  });

  it('fails closed instead of inventing a native location for a format mismatch', () => {
    const malformed = {
      ...packet('mismatched location', null, {
        format: 'pdf',
        pageIndex: 2,
        quote: { exact: 'mismatched location', prefix: '', suffix: '' },
      }),
    };

    expect(() => fitAgentContextPacketToByteBudget(malformed, false)).toThrow('anchor and location formats must match');
  });
});
