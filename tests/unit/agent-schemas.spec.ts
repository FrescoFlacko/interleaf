import { describe, expect, it } from 'vitest';
import { agentContextPacketSchema, agentDocumentSessionRequestSchema, agentEventSchema, agentListSessionsRequestSchema, agentStartRequestSchema, AGENT_MAX_CONTEXT_PACKET_BYTES, AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import type { MutablePortableRecord } from '@shared/models/portable';
import { eventError } from '../helpers/agent-event';
const baseErrorEvent = {
  sessionId: 'schema-session',
  ordinal: 0,
  type: 'error' as const,
  timestamp: '2026-08-25T00:00:00.000Z',
  error: {
    __interleafError: true as const,
    code: 'internal',
    message: 'The provider failed.',
  },
};

describe('agent event bounded serialized errors', () => {
  it('retains safe bounded diagnostic extras', () => {
    const result = agentEventSchema.safeParse({
      ...baseErrorEvent,
      error: {
        ...baseErrorEvent.error,
        diagnosticId: 'diag-123',
        retryable: true,
        details: {
          provider: 'fake',
          attempts: 2,
          tags: ['bounded', 'safe'],
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(eventError(result.data)).toMatchObject({
        diagnosticId: 'diag-123',
        details: { provider: 'fake', tags: ['bounded', 'safe'] },
      });
    }
  });

  // Size, depth, key-count and key-length bounds on error extras are in the chat-wire-contract table.
  it.each([
    ['overwide error extra array', () => ({ diagnostic: Array.from({ length: 129 }, () => 'value') })],
    ['cyclic error extras', () => {
      const diagnostic: MutablePortableRecord = { label: 'cycle' };
      diagnostic.self = diagnostic;
      return { diagnostic };
    }],
  ])('rejects %s', (_name, makeExtras) => {
    const result = agentEventSchema.safeParse({
      ...baseErrorEvent,
      error: { ...baseErrorEvent.error, ...makeExtras() },
    });

    expect(result.success).toBe(false);
  });
});

describe('agentContextPacketSchema context bounds', () => {
  const basePacket = {
    version: 1 as const,
    document: {
      id: 'doc-1',
      hash: 'hash-123',
      title: 'Sample Document',
      author: 'Author Name',
    },
    selection: {
      exactQuote: 'Hello world',
      anchor: {
        format: 'pdf' as const,
        quote: { exact: 'Hello world', prefix: '', suffix: '' },
        pageIndex: 0,
        pageLabel: '1',
      },
      location: {
        format: 'pdf' as const,
        pageIndex: 0,
        pageLabel: '1',
      },
      surroundingText: null,
    },
    provenance: {
      source: 'interleaf-reader-selection' as const,
      capturedAt: '2026-08-26T18:00:00.000Z',
      contentIsUntrustedReference: true as const,
    },
  };

  it.each([
    ['accepts', AGENT_MAX_CONTEXT_TEXT_LENGTH, true],
    ['rejects', AGENT_MAX_CONTEXT_TEXT_LENGTH + 1, false],
  ] as const)('%s context packet with a quote of %i characters (bound 256,000)', (_verb, length, accepted) => {
    const result = agentContextPacketSchema.safeParse({
      ...basePacket,
      selection: { ...basePacket.selection, exactQuote: 'A'.repeat(length) },
    });

    expect(result.success).toBe(accepted);
  });

  it('rejects context packets whose anchor and location formats disagree', () => {
    const result = agentContextPacketSchema.safeParse({
      ...basePacket,
      selection: {
        ...basePacket.selection,
        anchor: {
          format: 'markdown',
          blockIndex: 0,
          quote: { exact: 'Hello world', prefix: '', suffix: '' },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes('formats must match'))).toBe(true);
  });

  it('safely defaults older persisted packet without truncated metadata to truncated: false', () => {
    const olderPacket = {
      ...basePacket,
      selection: {
        ...basePacket.selection,
        exactQuote: 'Unmodified older quote',
      },
      provenance: {
        source: 'interleaf-reader-selection' as const,
        capturedAt: '2026-08-26T18:00:00.000Z',
        contentIsUntrustedReference: true as const,
      },
    };

    const result = agentContextPacketSchema.safeParse(olderPacket);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance.truncated).toBe(false);
    }
  });

  it('accepts explicit truncated: true', () => {
    const truncatedPacket = {
      ...basePacket,
      selection: {
        ...basePacket.selection,
        exactQuote: 'A'.repeat(AGENT_MAX_CONTEXT_TEXT_LENGTH),
      },
      provenance: {
        source: 'interleaf-reader-selection' as const,
        capturedAt: '2026-08-26T18:00:00.000Z',
        contentIsUntrustedReference: true as const,
        truncated: true,
      },
    };

    const result = agentContextPacketSchema.safeParse(truncatedPacket);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance.truncated).toBe(true);
    }
  });

  it('accepts a bounded section packet with canonical text and a location-only anchor', () => {
    const packet = {
      ...basePacket,
      scopeLabel: 'Section 1',
      selection: {
        ...basePacket.selection,
        exactQuote: 'A'.repeat(255_000),
        anchor: {
          ...basePacket.selection.anchor,
          quote: { exact: '', prefix: '', suffix: '' },
        },
      },
    };
    const result = agentContextPacketSchema.safeParse(packet);
    expect(result.success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
  });
});

describe('agent session document schemas', () => {
  it('requires both the session and document IDs when loading session detail', () => {
    expect(agentDocumentSessionRequestSchema.safeParse({ sessionId: 'session-1', documentId: 'doc-1' }).success).toBe(true);
    expect(agentDocumentSessionRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(false);
    expect(agentDocumentSessionRequestSchema.safeParse({ documentId: 'doc-1' }).success).toBe(false);
    expect(agentDocumentSessionRequestSchema.safeParse({ sessionId: 'session-1', documentId: 'doc-1', extra: true }).success).toBe(false);
  });

  it('validates agentListSessionsRequestSchema with valid documentId and rejects invalid inputs', () => {
    expect(agentListSessionsRequestSchema.safeParse({ documentId: 'doc-1' }).success).toBe(true);
    for (const invalid of [undefined, { documentId: '' }, { documentId: '   ' }, { documentId: 123 }, { documentId: 'x'.repeat(129) }, { documentId: 'doc-1', extra: true }]) {
      expect(agentListSessionsRequestSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('validates agentStartRequestSchema documentId and verifies consistency with contextPacket', () => {
    const validBase = {
      profileId: 'fake',
      workingDirectoryHandle: 'handle-1',
      prompt: 'do work',
    };
    // 1. A document binding is required.
    expect(agentStartRequestSchema.safeParse(validBase).success).toBe(false);

    // 2. Valid with documentId
    expect(agentStartRequestSchema.safeParse({ ...validBase, documentId: 'doc-1' }).success).toBe(true);

    // 3. Rejects invalid documentId (empty, whitespace, overlong)
    expect(['', '   ', 'x'.repeat(129)].map((documentId) => agentStartRequestSchema.safeParse({ ...validBase, documentId }).success)).toEqual([false, false, false]);

    // 4. Matches contextPacket document.id
    const matchingPacket = {
      version: 1 as const,
      document: { id: 'doc-matching', hash: 'hash-123', title: 'Doc', author: null },
      selection: {
        exactQuote: 'Quote',
        anchor: { format: 'pdf' as const, quote: { exact: 'Quote', prefix: '', suffix: '' }, pageIndex: 0 },
        location: { format: 'pdf' as const, pageIndex: 0 },
        surroundingText: null,
      },
      provenance: { source: 'interleaf-reader-selection' as const, capturedAt: '2026-08-25T00:00:00.000Z', contentIsUntrustedReference: true as const },
    };
    expect(agentStartRequestSchema.safeParse({
      ...validBase,
      documentId: 'doc-matching',
      contextPacket: matchingPacket,
    }).success).toBe(true);

    // 5. Mismatched contextPacket document.id fails validation
    const mismatchResult = agentStartRequestSchema.safeParse({
      ...validBase,
      documentId: 'doc-other',
      contextPacket: matchingPacket,
    });
    expect(mismatchResult.success).toBe(false);
    if (!mismatchResult.success) {
      expect(mismatchResult.error.issues[0]?.message).toMatch(/Context packet document ID must match the session document ID/i);
    }
  });
});
