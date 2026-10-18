import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import {
  aiProviderIdSchema,
  attachChatContextRequestSchema,
  cancelChatRequestSchema,
  chatSessionListReplySchema,
  chatSessionSchema,
  createChatSessionRequestSchema,
  deleteChatSessionRequestSchema,
  getAIProviderStatusRequestSchema,
  getChatSessionRequestSchema,
  listChatContextRequestSchema,
  listChatMessagesRequestSchema,
  listChatSessionsRequestSchema,
  removeChatContextRequestSchema,
  resolveChatCitationRequestSchema,
  sendChatMessageRequestSchema,
  setCredentialRequestSchema,
  updateChatSessionRequestSchema,
} from '@shared/schemas/ai';

describe('AI Zod contracts and schemas', () => {
  it('validates provider identifiers against the enum allowlist', () => {
    expect(aiProviderIdSchema.safeParse('fake').success).toBe(false);
    expect(aiProviderIdSchema.safeParse('codex').success).toBe(true);
    expect(aiProviderIdSchema.safeParse('claude').success).toBe(true);
    expect(aiProviderIdSchema.safeParse('antigravity').success).toBe(true);
    expect(aiProviderIdSchema.safeParse('openrouter').success).toBe(true);
    expect(aiProviderIdSchema.safeParse('unknown-provider').success).toBe(false);
  });

  it('validates chat session creation requests and accepts generic CLI model identifiers', () => {
    const valid = {
      documentId: 'doc-1',
      title: 'Research conversation',
      providerId: 'codex',
      modelId: 'o3-mini',
    };
    expect(createChatSessionRequestSchema.safeParse(valid).success).toBe(true);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, providerId: 'claude', modelId: 'claude-3-5-sonnet' }).success).toBe(true);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, providerId: 'codex', modelId: 'o3-mini' }).success).toBe(true);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, providerId: 'openrouter', modelId: 'anthropic/claude-3.7-sonnet:thinking' }).success).toBe(true);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, title: 'a'.repeat(201) }).success).toBe(false);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, modelId: '' }).success).toBe(false);
    expect(createChatSessionRequestSchema.safeParse({ ...valid, extraField: 123 }).success).toBe(false);
    expect(ipcRequestSchemas[IPC.chatCreateSession]).toBe(createChatSessionRequestSchema);
  });

  it('validates session lifecycle schemas (get, list, update, delete)', () => {
    // Detail hydration is document-scoped: both IDs are required, and a
    // session-only payload can no longer reach main.
    expect(getChatSessionRequestSchema.safeParse({ sessionId: 'session-1', documentId: 'doc-1' }).success).toBe(true);
    expect(getChatSessionRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(false);
    expect(getChatSessionRequestSchema.safeParse({ documentId: 'doc-1' }).success).toBe(false);
    expect(getChatSessionRequestSchema.safeParse({ sessionId: '', documentId: 'doc-1' }).success).toBe(false);
    expect(getChatSessionRequestSchema.safeParse({ sessionId: 'session-1', documentId: '' }).success).toBe(false);
    expect(listChatSessionsRequestSchema.safeParse({ documentId: 'doc-1' }).success).toBe(true);
    expect(deleteChatSessionRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(true);
    expect(listChatMessagesRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(true);
    expect(listChatContextRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(true);
    expect(removeChatContextRequestSchema.safeParse({ sessionId: 'session-1', contextItemId: 'ctx-1' }).success).toBe(true);
    expect(removeChatContextRequestSchema.safeParse({ sessionId: 'session-1', contextItemId: '' }).success).toBe(false);

    // Update requires at least one field
    expect(updateChatSessionRequestSchema.safeParse({ sessionId: 's-1' }).success).toBe(false);
    expect(updateChatSessionRequestSchema.safeParse({ sessionId: 's-1', title: 'Renamed' }).success).toBe(true);
    expect(updateChatSessionRequestSchema.safeParse({ sessionId: 's-1', providerId: 'codex' }).success).toBe(true);
    expect(updateChatSessionRequestSchema.safeParse({ sessionId: 's-1', modelId: 'm-1' }).success).toBe(true);
  });

  it('validates context attachment inputs with discriminated union and bounds', () => {
    const base = {
      sessionId: 'session-1',
      documentId: 'doc-1',
      documentHash: 'hash-1',
    };

    // Selection attachment
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'selection',
          descriptor: {
            format: 'pdf',
            startPageIndex: 0,
            endPageIndex: 0,
            startQuote: { exact: 'Important passage', prefix: '', suffix: '' },
            endQuote: { exact: 'Important passage', prefix: '', suffix: '' },
          },
        },
      }).success
    ).toBe(true);

    // Location attachment
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'location',
          location: { format: 'docx', paragraphIndex: 5 },
        },
      }).success
    ).toBe(true);

    // PDF page range attachment
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'range',
          format: 'pdf',
          pageStart: 1,
          pageEnd: 5,
        },
      }).success
    ).toBe(true);

    // Reversed page range is rejected
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'range',
          format: 'pdf',
          pageStart: 10,
          pageEnd: 5,
        },
      }).success
    ).toBe(false);

    // Excessive page range (> 250) is rejected
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'range',
          format: 'pdf',
          pageStart: 1,
          pageEnd: 300,
        },
      }).success
    ).toBe(false);

    // Entire document attachment
    expect(
      attachChatContextRequestSchema.safeParse({
        ...base,
        input: {
          kind: 'entire_document',
          location: { format: 'pdf', pageIndex: 0 },
        },
      }).success
    ).toBe(true);
  });

  it('validates chat message sending and cancellation schemas', () => {
    expect(
      sendChatMessageRequestSchema.safeParse({
        sessionId: 'session-1',
        content: 'Explain the architecture.',
      }).success
    ).toBe(true);

    // Empty content rejected
    expect(
      sendChatMessageRequestSchema.safeParse({
        sessionId: 'session-1',
        content: '   ',
      }).success
    ).toBe(false);

    // Message exceeding 100,000 characters rejected
    expect(
      sendChatMessageRequestSchema.safeParse({
        sessionId: 'session-1',
        content: 'x'.repeat(100_001),
      }).success
    ).toBe(false);

    // Cancel requires valid UUID requestId
    expect(
      cancelChatRequestSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true);
    expect(
      cancelChatRequestSchema.safeParse({
        requestId: 'not-a-uuid',
      }).success
    ).toBe(false);
  });

  it('validates provider status and credential schemas', () => {
    expect(
      getAIProviderStatusRequestSchema.safeParse({
        providerId: 'openrouter',
      }).success
    ).toBe(true);

    expect(
      setCredentialRequestSchema.safeParse({
        providerId: 'openrouter',
        secret: 'sk-or-v1-secret-key',
      }).success
    ).toBe(true);

    expect(
      setCredentialRequestSchema.safeParse({
        providerId: 'openrouter',
        secret: '',
      }).success
    ).toBe(false);

    // Excessive secret rejected
    expect(
      setCredentialRequestSchema.safeParse({
        providerId: 'openrouter',
        secret: 'x'.repeat(513),
      }).success
    ).toBe(false);
  });

  it('validates citation resolution schema', () => {
    expect(
      resolveChatCitationRequestSchema.safeParse({
        sessionId: 'session-1',
        messageId: 'msg-1',
        sourceId: 'src-1',
      }).success
    ).toBe(true);

    expect(
      resolveChatCitationRequestSchema.safeParse({
        sessionId: 'session-1',
        messageId: 'msg-1',
        sourceId: '',
      }).success
    ).toBe(false);
  });

  describe('chat session projection', () => {
    const session = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      documentId: '550e8400-e29b-41d4-a716-446655440001',
      documentHash: 'a'.repeat(64),
      title: 'Consensus questions',
      providerId: 'claude',
      modelId: 'claude-opus-5',
      reasoningEffort: null,
      messageCount: 4,
      previewText: 'What is a quorum?',
      isArchived: false,
      compactedThroughOrdinal: 3,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    };

    it('carries the compaction boundary and nothing else about the summary', () => {
      expect(chatSessionSchema.safeParse(session).success).toBe(true);
      expect(chatSessionSchema.safeParse({ ...session, compactedThroughOrdinal: null }).success).toBe(true);
      // The stored summary is untrusted model output that no surface renders, so
      // a reply carrying it is rejected outright rather than ignored.
      expect(
        chatSessionSchema.safeParse({ ...session, contextSummary: 'The reader asked about quorums.' })
          .success
      ).toBe(false);
      expect(chatSessionSchema.safeParse({ ...session, compactedThroughOrdinal: -1 }).success).toBe(false);
      expect(chatSessionSchema.safeParse({ ...session, compactedThroughOrdinal: 1.5 }).success).toBe(false);
    });

    it('bounds a session list reply', () => {
      expect(chatSessionListReplySchema.safeParse([session]).success).toBe(true);
      expect(
        chatSessionListReplySchema.safeParse([{ ...session, providerId: 'unknown-provider' }]).success
      ).toBe(false);
    });
  });
});
