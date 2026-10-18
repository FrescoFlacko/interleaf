import { InterleafError } from '@shared/errors/interleaf-error';
import { isReasoningEffort } from '@shared/constants/reasoning';
import { chatContextDisclosureSchema } from '@shared/schemas/chat-wire';
import { parseDocumentLocation } from '@shared/schemas/document';
import { parseWebSources } from './chat-web-sources';
import { sessionPreview } from './chat-session-summary';
import type {
  AIProviderId,
  ChatCitation,
  ChatContextDisclosure,
  ChatContextItem,
  ChatContextKind,
  ChatMessage,
  ChatMessageStatus,
  ChatSession,
  ReasoningEffort,
} from '@shared/types/ai';
import { type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';

export type SessionRow = {
  id: string;
  document_id: string;
  document_hash: string;
  title: string;
  provider_id: AIProviderId;
  model_id: string | null;
  reasoning_effort?: string | null;
  message_count: number;
  preview_text?: string | null;
  preview_citation_json?: string | null;
  compacted_through_ordinal?: number | null;
  current_document_hash?: string;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  session_id: string;
  role: ChatMessage['role'];
  ordinal: number;
  content: string;
  citation_json: string | null;
  disclosures_json: string | null;
  web_sources_json: string | null;
  status: ChatMessageStatus;
  request_id: string | null;
  token_count: number | null;
  error_message: string | null;
  created_at: string;
};

export type ContextRow = {
  id: string;
  session_id: string;
  kind: ChatContextKind;
  source_ref_json: string;
  excerpt_text: string;
  excerpt_hash: string;
  document_hash: string;
  anchor_json: string;
  provenance_json: string;
  display_label: string;
  pinned: number;
  created_at: string;
};

function parseJsonRecord(value: string, field: string): PortableRecord {
  try {
    const parsed: PortableValue = parsePortableJson(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as PortableRecord;
    }
  } catch {
    // Fall through to one stable corruption error.
  }
  throw new InterleafError('internal', `Stored ${field} is invalid.`);
}

function parseCitations(value: string | null): ChatCitation[] {
  if (value === null) return [];
  try {
    const parsed: PortableValue = parsePortableJson(value);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const items = parsed as PortableValue[];
    return items.map((item: PortableValue) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('sourceId' in item) ||
        !('label' in item) ||
        typeof item.sourceId !== 'string' ||
        typeof item.label !== 'string'
      ) {
        throw new Error('invalid citation');
      }
      return {
        sourceId: item.sourceId,
        label: item.label,
        pageLabel: 'pageLabel' in item && typeof item.pageLabel === 'string' ? item.pageLabel : null,
        heading: 'heading' in item && typeof item.heading === 'string' ? item.heading : null,
      };
    });
  } catch (error) {
    throw new InterleafError('internal', 'Stored chat citations are invalid.', { cause: error instanceof Error ? error : null });
  }
}

/**
 * The stored requested effort, or Default. The column CHECK already limits
 * values; an unrecognised one (a newer build's vocabulary) reads as Default
 * rather than failing the whole session list.
 */
export function readStoredEffort(value: string | null | undefined): ReasoningEffort | null {
  return typeof value === 'string' && isReasoningEffort(value) ? value : null;
}

export function mapSession(row: SessionRow): ChatSession {
  const isArchived =
    row.current_document_hash !== undefined
      ? row.document_hash !== row.current_document_hash
      : false;
  return {
    id: row.id,
    documentId: row.document_id,
    documentHash: row.document_hash,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningEffort: readStoredEffort(row.reasoning_effort),
    messageCount: row.message_count,
    previewText: sessionPreview(row.preview_text, row.preview_citation_json),
    // Boundary metadata only. The stored summary never leaves main: the renderer
    // needs to know how much of the conversation a later turn would actually
    // replay, not what the model wrote about the rest.
    compactedThroughOrdinal: row.compacted_through_ordinal ?? null,
    isArchived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Fail-soft: a NULL column (nothing disclosed, or a pre-column row) and a corrupt blob both read back as none.
function parseDisclosures(json: string | null): ChatContextDisclosure[] {
  if (json === null) return [];
  try {
    const raw: PortableValue = parsePortableJson(json);
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => chatContextDisclosureSchema.safeParse(item)).filter((result) => result.success).map((result) => result.data);
  } catch {
    return [];
  }
}

export function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    ordinal: row.ordinal,
    content: row.content,
    citations: parseCitations(row.citation_json),
    disclosures: parseDisclosures(row.disclosures_json),
    webSources: parseWebSources(row.web_sources_json),
    status: row.status,
    requestId: row.request_id,
    tokenCount: row.token_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export function mapContext(row: ContextRow): ChatContextItem {
  let rawLocation: PortableValue;
  try {
    rawLocation = parsePortableJson(row.anchor_json);
  } catch (error) {
    throw new InterleafError('internal', 'Stored chat context location is invalid JSON.', { cause: error instanceof Error ? error : null });
  }
  const location = parseDocumentLocation(rawLocation);
  if (!location) throw new InterleafError('internal', 'Stored chat context location failed validation.');
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    sourceRef: parseJsonRecord(row.source_ref_json, 'chat context source reference'),
    excerptText: row.excerpt_text,
    excerptHash: row.excerpt_hash,
    documentHash: row.document_hash,
    location,
    provenance: parseJsonRecord(row.provenance_json, 'chat context provenance'),
    displayLabel: row.display_label,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  };
}
