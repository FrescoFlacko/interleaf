import {
  CHAT_CONTEXT_HEADROOM_TOKENS,
  CHAT_DEFAULT_RETRIEVAL_LIMIT,
  CHAT_FULL_DOCUMENT_RATIO,
  CHAT_MAX_SOURCES_PER_REQUEST,
  CHAT_REPLAY_CONTEXT_RATIO,
  CHAT_REPLAY_MAX_SOURCES,
  READER_AI_SYSTEM_PROMPT,
  READER_AI_WEB_SEARCH_SYSTEM_PROMPT,
} from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type {
  AIModelInfo,
  ChatContextBudgetBreakdown,
  ChatContextDisclosure,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatSourceEnvelopeItem,
} from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import type {
  ChatContextSource,
  ContextChunk,
  ContextDocument,
} from './context-repository';
export type { ChatContextSource };
import { estimateChatTokens, estimateSourceEnvelopeTokens } from './context-tokens';
export { estimateChatTokens };
import { adoptedBandLabel } from './nearby-band-label';
import { packPinnedWholeDocument } from './pinned-whole-document';
import { serializeConversationSummaryXml, serializeProvenanceXml } from './provenance-serializer';
import {
  chunkToSource,
  contextItemToSource,
  formatSourceLabel,
  replayToSource,
  type ReplayedChatSource,
} from './source-drafts';
export { formatSourceLabel };
export type { ReplayedChatSource };
import {
  explicitWholeDocumentItem,
  hasExplicitWholeDocument,
  wholeDocumentFallbackDisclosures,
} from './whole-document-intent';
import type { PortableMember, PortableRecord } from '@shared/models/portable';

export type BuiltChatContext = {
  readonly systemPrompt: string;
  readonly contextXml: string;
  readonly history: readonly ChatMessage[];
  readonly sources: readonly ChatSourceEnvelopeItem[];
  readonly estimatedInputTokens: number;
  /**
   * The same estimate itemised by what it was spent on. It is assembled from
   * the charges applied above rather than measured again afterwards, so it adds
   * up to `estimatedInputTokens` by construction and cannot drift from what the
   * builder enforced.
   */
  readonly breakdown: ChatContextBudgetBreakdown;
  readonly fullDocIncluded: boolean;
  readonly disclosures: readonly ChatContextDisclosure[];
};

/**
 * The raw selection descriptor a pinned context item carries, under either of
 * the two names it has been stored under. Returns `undefined` when the item
 * carries neither; the caller then has no selection to resolve. The value is
 * untrusted and stays `unknown` until the resolver validates it.
 */
function selectionDescriptor(sourceRef: PortableRecord): PortableMember {
  if ('descriptor' in sourceRef) return sourceRef.descriptor;
  if ('anchor' in sourceRef) return sourceRef.anchor;
  return undefined;
}

export class ChatContextBuilder {
  constructor(private readonly context: ChatContextSource) {}

  build(input: {
    readonly session: ChatSession;
    readonly model: AIModelInfo;
    readonly question: string;
    readonly messages: readonly ChatMessage[];
    readonly contextItems: readonly ChatContextItem[];
    /**
     * Sources earlier accepted turns sent, most recent first. They are resent
     * as ordinary untrusted document context, bounded by count and by a fixed
     * share of the window, so a conversation keeps referring to context the
     * user submitted once without that context growing without limit.
     */
    readonly priorSources?: readonly ReplayedChatSource[];
    readonly currentLocation?: DocumentLocation | null;
    /**
     * A stored, model-authored summary of the part of this conversation that was
     * compacted away, if any. It stands in for the messages before the
     * compaction boundary, and it travels in the request's untrusted data block
     * — never in the system prompt — on the same terms as document text.
     */
    readonly contextSummary?: string | null;
    /** Set only for a turn already validated against the provider capability. */
    readonly webSearch?: boolean;
  }): BuiltChatContext {
    const documentInfo = this.context.getDocument(input.session.documentId, input.session.documentHash);
    const docHeader = {
      title: documentInfo.title,
      format: documentInfo.format,
      documentHash: documentInfo.documentHash,
    };

    // The prompt describes what this turn can actually do, and the budget is
    // estimated from that same prompt rather than from the default one.
    const systemPrompt = input.webSearch === true
      ? READER_AI_WEB_SEARCH_SYSTEM_PROMPT
      : READER_AI_SYSTEM_PROMPT;

    // A compaction summary is charged up front, alongside the framing it stands
    // beside, so every later packing decision is made against a budget that
    // already accounts for it.
    const summary = conversationSummaryEnvelope(input.contextSummary);
    const summaryTokens = summary.tokens;

    const fixedTokens =
      estimateChatTokens(systemPrompt) +
      estimateChatTokens(input.question) +
      input.model.maxOutputTokens +
      CHAT_CONTEXT_HEADROOM_TOKENS +
      summaryTokens;

    if (fixedTokens >= input.model.contextWindow) {
      throw new InterleafError('validation', 'The question and response reserve exceed this model context window.');
    }

    const drafts: ChatSourceEnvelopeItem[] = [];
    const disclosures: ChatContextDisclosure[] = [];
    // 1. Explicit pinned context items (highest priority)
    const explicit = input.contextItems.filter((item) => item.pinned && item.kind !== 'entire_document');
    for (const item of explicit) {
      if (item.kind === 'selection') {
        const descriptor = selectionDescriptor(item.sourceRef);
        const resolution = descriptor
          ? this.context.resolveSelectionChunks(documentInfo.id, documentInfo.documentHash, descriptor)
          : { chunks: [], boundaryOverIncluded: false };
        const chunks = resolution.chunks;
        if (chunks.length > 0) {
          let selectionIncludedCount = 0;
          let hitSourceLimit = false;
          let currentDraftsXmlCost = estimateChatTokens(serializeProvenanceXml(docHeader, drafts));
          for (const chunk of chunks) {
            if (drafts.length >= CHAT_MAX_SOURCES_PER_REQUEST) {
              hitSourceLimit = true;
              break;
            }
            const candidate: ChatSourceEnvelopeItem = {
              ...chunkToSource(documentInfo, chunk),
              contextItemId: item.id,
              sourceId: `src-${String(drafts.length + 1)}`,
            };
            const singleSourceCost = estimateSourceEnvelopeTokens(candidate);
            if (fixedTokens + currentDraftsXmlCost + singleSourceCost <= input.model.contextWindow) {
              drafts.push(candidate);
              currentDraftsXmlCost += singleSourceCost;
              selectionIncludedCount += 1;
            } else {
              break;
            }
          }
          if (selectionIncludedCount === 0) {
            throw new InterleafError(
              'validation',
              `Explicit context “${item.displayLabel}” does not fit this model. Remove or narrow pinned context.`
            );
          }
          if (selectionIncludedCount < chunks.length) {
            disclosures.push({
              contextItemId: item.id,
              displayLabel: item.displayLabel,
              totalChunks: chunks.length,
              includedChunks: selectionIncludedCount,
              omittedChunks: chunks.length - selectionIncludedCount,
              reason: hitSourceLimit ? 'max_sources_per_request' : 'model_context_window',
            });
          }
          // Boundary uncertainty is independent of context-budget clipping.
          // Keep both disclosures so the user can distinguish extra text at a
          // boundary from chunks omitted by the model/source limits.
          if (resolution.boundaryOverIncluded) {
            disclosures.push({
              contextItemId: item.id,
              displayLabel: item.displayLabel,
              totalChunks: chunks.length,
              includedChunks: selectionIncludedCount,
              omittedChunks: chunks.length - selectionIncludedCount,
              reason: 'boundary_over_inclusion',
            });
          }
          continue;
        }
      }

      const sourceDraft = contextItemToSource(documentInfo, item);
      const candidate: ChatSourceEnvelopeItem = {
        ...sourceDraft,
        sourceId: `src-${String(drafts.length + 1)}`,
      };

      const candidateXml = serializeProvenanceXml(docHeader, [...drafts, candidate]);
      const candidateCost = fixedTokens + estimateChatTokens(candidateXml);
      if (candidateCost > input.model.contextWindow) {
        throw new InterleafError(
          'validation',
          `Explicit context “${item.displayLabel}” does not fit this model. Remove or narrow pinned context.`
        );
      }
      drafts.push(candidate);
    }

    // 2. Select recent history
    const currentExplicitXml = serializeProvenanceXml(docHeader, drafts);
    const usedByExplicit = fixedTokens + estimateChatTokens(currentExplicitXml);
    const remainingForHistory = Math.max(0, input.model.contextWindow - usedByExplicit);
    const historyBudget = Math.min(remainingForHistory, Math.floor(input.model.contextWindow * 0.2));
    const history = selectRecentHistory(input.messages, historyBudget);
    const historyTokens = history.reduce((total, message) => total + estimateChatTokens(message.content) + 12, 0);

    // 3. Replay of what earlier turns in this conversation actually sent.
    //
    // What a turn sent was particular to it: attached chips persist, but
    // retrieved passages, nearby bands and selections removed since do not, so a
    // follow-up question would otherwise arrive with the history but not the
    // passages the history is about. The stored snapshots are resent here as ordinary
    // untrusted document context — never as history, never merged into an
    // answer — most recent first, deduplicated against what this turn already
    // carries, and bounded both by count and by a fixed share of the window.
    const explicitDraftCount = drafts.length;
    const explicitDrafts = [...drafts];
    packReplaySources(
      docHeader,
      documentInfo,
      drafts,
      input.priorSources,
      input.model.contextWindow,
      fixedTokens + historyTokens
    );

    const stats = this.context.getPublishedStats(documentInfo.id, documentInfo.documentHash);
    // Only a whole document the user pinned themselves carries explicit
    // authority. An automatically attached one is Level-2 context and takes the
    // ratio-gated path below, falling back to retrieval when it does not fit.
    const entireDocumentPinned = hasExplicitWholeDocument(input.contextItems);

    const maxAdditionalSources = Math.max(0, CHAT_MAX_SOURCES_PER_REQUEST - drafts.length);

    let fullDocIncluded = false;
    // Where the nearby band landed, read back off the sources that were packed.
    let nearbyLabel: string | null = null;

    if (entireDocumentPinned) {
      if (!stats || stats.chunkCount === 0) {
        throw new InterleafError(
          'validation',
          'No indexed or explicitly selected document context is available.'
        );
      }
      // Too large to send whole is not a refusal: the packer falls back to a
      // bounded band of context around where the reader actually is.
      const packed = packPinnedWholeDocument({
        docHeader,
        chunks: this.context.listPublishedChunks(documentInfo.id, documentInfo.documentHash),
        stats,
        toSource: (chunk) => chunkToSource(documentInfo, chunk),
        explicitDrafts,
        anchor: pinnedContextAnchor(input.currentLocation, input.contextItems),
        contextWindow: input.model.contextWindow,
        baseTokens: fixedTokens + historyTokens,
      });
      const adopted = adoptPinnedSources(drafts, packed.sources, explicitDrafts.length);
      fullDocIncluded = packed.fullDocIncluded;
      nearbyLabel = adoptedBandLabel({
        adopted,
        fullDocIncluded,
        sources: packed.sources,
        explicitCount: explicitDrafts.length,
      });
    } else {
      if (
        explicitDraftCount === 0 &&
        stats &&
        stats.chunkCount > 0 &&
        stats.chunkCount <= maxAdditionalSources &&
        stats.estimatedTokens <= Math.floor(input.model.contextWindow * CHAT_FULL_DOCUMENT_RATIO)
      ) {
        const chunks = this.context.listPublishedChunks(documentInfo.id, documentInfo.documentHash);
        const candidateSources = [
          ...explicitDrafts,
          ...chunks.map((chunk, index) => ({
            ...chunkToSource(documentInfo, chunk),
            sourceId: `src-${String(explicitDrafts.length + index + 1)}`,
          })),
        ];
        const candidateXml = serializeProvenanceXml(docHeader, candidateSources);
        const totalTokens = fixedTokens + historyTokens + estimateChatTokens(candidateXml);
        if (totalTokens <= input.model.contextWindow) {
          drafts.length = 0;
          drafts.push(...candidateSources);
          fullDocIncluded = true;
        }
      }

      if (!fullDocIncluded && stats && stats.chunkCount > 0 && maxAdditionalSources > 0) {
        let retrieved: readonly ContextChunk[];
        try {
          retrieved = this.context.retrieve(
            documentInfo.id,
            documentInfo.documentHash,
            input.question,
            Math.min(CHAT_DEFAULT_RETRIEVAL_LIMIT, maxAdditionalSources),
            input.currentLocation
          );
        } catch (error) {
          if (!(error instanceof InterleafError) || error.code !== 'validation') throw error;
          retrieved = this.context.listPublishedChunks(documentInfo.id, documentInfo.documentHash).slice(0, 3);
        }
        if (retrieved.length === 0) {
          retrieved = this.context.listPublishedChunks(documentInfo.id, documentInfo.documentHash).slice(0, 3);
        }

        for (const chunk of retrieved) {
          if (drafts.length >= CHAT_MAX_SOURCES_PER_REQUEST) break;
          if (drafts.some((d) => d.chunkId === chunk.id)) continue;
          const candidate: ChatSourceEnvelopeItem = {
            ...chunkToSource(documentInfo, chunk),
            sourceId: `src-${String(drafts.length + 1)}`,
          };
          const testXml = serializeProvenanceXml(docHeader, [...drafts, candidate]);
          const totalCost = fixedTokens + historyTokens + estimateChatTokens(testXml);
          if (totalCost <= input.model.contextWindow) {
            drafts.push(candidate);
          }
        }
      }
    }

    // A whole-document attachment that had to fall back — to retrieval when it
    // was automatic, to a nearby band when the reader pinned it — says so on the
    // turn, so the conversation never implies the whole document was sent when
    // only part of it was.
    disclosures.push(
      ...wholeDocumentFallbackDisclosures(input.contextItems, {
        fullDocIncluded,
        includedChunks: uniqueChunkSourceCount(drafts),
        stats,
        includedLabel: nearbyLabel,
      })
    );

    if (drafts.length === 0) {
      throw new InterleafError(
        'validation',
        'No indexed or explicitly selected document context is available for this question.'
      );
    }
    if (drafts.length > CHAT_MAX_SOURCES_PER_REQUEST) {
      throw new InterleafError('validation', 'The document produced too many AI context sources.');
    }

    // Safety trim if auto-retrieval edge case exceeded context window
    while (
      drafts.length > explicit.length &&
      fixedTokens + historyTokens + estimateChatTokens(serializeProvenanceXml(docHeader, drafts)) > input.model.contextWindow
    ) {
      drafts.pop();
    }

    // Re-index source IDs in sequential order
    const finalSources = drafts.map((source, index) => ({
      ...source,
      sourceId: `src-${String(index + 1)}`,
    }));

    const finalXml = serializeProvenanceXml(docHeader, finalSources);
    const documentContextTokens = estimateChatTokens(finalXml);
    const finalTotalTokens = fixedTokens + historyTokens + documentContextTokens;

    if (finalTotalTokens > input.model.contextWindow) {
      throw new InterleafError('validation', 'The context envelope exceeds this model context window.');
    }

    // The summary is counted with the history it replaces, which is what it is
    // and what keeps the breakdown adding up to the enforced total.
    const breakdown = assembleBudgetBreakdown(
      systemPrompt,
      input.question,
      historyTokens + summaryTokens,
      documentContextTokens,
      input.model.maxOutputTokens,
      finalSources
    );
    return {
      systemPrompt,
      contextXml: summary.prependTo(finalXml),
      sources: finalSources,
      history,
      estimatedInputTokens: finalTotalTokens,
      breakdown,
      fullDocIncluded,
      disclosures,
    };
  }
}

/**
 * The stored conversation summary as it travels: serialized once, charged once,
 * and placed beside the document context rather than in the system prompt.
 *
 * A summary is model-authored text about untrusted material, so it is data in
 * the request's data block on exactly the terms document passages are.
 */
function conversationSummaryEnvelope(contextSummary: string | null | undefined): {
  readonly tokens: number;
  readonly prependTo: (contextXml: string) => string;
} {
  const text = contextSummary?.trim() ?? '';
  if (text.length === 0) return { tokens: 0, prependTo: (contextXml) => contextXml };
  const xml = serializeConversationSummaryXml(text);
  return { tokens: estimateChatTokens(xml), prependTo: (contextXml) => `${xml}\n${contextXml}` };
}

/**
 * Where a band of nearby context is centred.
 *
 * The reader's live position at send time is the truthful anchor. When the turn
 * carries none — a send from a restored session, a format without a reported
 * location — the position recorded when the document was pinned stands in, so
 * the band still comes from where the reader was rather than from page one.
 */
function pinnedContextAnchor(
  currentLocation: DocumentLocation | null | undefined,
  contextItems: readonly ChatContextItem[]
): DocumentLocation | null {
  return currentLocation ?? explicitWholeDocumentItem(contextItems)?.location ?? null;
}

/**
 * Adopts what the pinned-document packer produced, unless it found nothing but
 * the explicit selections it started from — in which case the drafts already
 * assembled, replayed sources included, remain the better envelope.
 */
function adoptPinnedSources(
  drafts: ChatSourceEnvelopeItem[],
  packed: readonly ChatSourceEnvelopeItem[],
  explicitCount: number
): boolean {
  if (packed.length <= explicitCount) return false;
  drafts.length = 0;
  drafts.push(...packed);
  return true;
}

/** How many of the packed sources came from the index, for disclosure counts. */
/**
 * How much of the document the request actually carries, in indexed chunks.
 *
 * Counted by distinct chunk id, not by envelope entry: one chunk can be packed
 * more than once — as an explicit selection, as a replayed source from an
 * earlier turn and again inside a nearby band — and counting each copy would
 * overstate the coverage the fallback disclosure claims.
 */
function uniqueChunkSourceCount(drafts: readonly ChatSourceEnvelopeItem[]): number {
  const chunkIds = new Set<string>();
  for (const draft of drafts) {
    if (draft.chunkId !== null) chunkIds.add(draft.chunkId);
  }
  return chunkIds.size;
}

function selectRecentHistory(messages: readonly ChatMessage[], budget: number): readonly ChatMessage[] {
  const selected: ChatMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.status === 'streaming' || message.status === 'failed') continue;
    const cost = estimateChatTokens(message.content) + 12;
    if (used + cost > budget) break;
    selected.push(message);
    used += cost;
  }
  return selected.reverse();
}

function packReplaySources(
  docHeader: { readonly title: string; readonly format: ContextDocument['format']; readonly documentHash: string },
  documentInfo: ContextDocument,
  drafts: ChatSourceEnvelopeItem[],
  priorSources: readonly ReplayedChatSource[] | undefined,
  contextWindow: number,
  baseTokens: number
): void {
  const explicitCount = drafts.length;
  const replayBudget = Math.floor(contextWindow * CHAT_REPLAY_CONTEXT_RATIO);
  let replayTokens = 0;
  for (const prior of priorSources ?? []) {
    if (drafts.length - explicitCount >= CHAT_REPLAY_MAX_SOURCES) break;
    if (drafts.length >= CHAT_MAX_SOURCES_PER_REQUEST) break;
    const isDuplicate = drafts.some(
      (draft) =>
        (prior.chunkId !== null && draft.chunkId === prior.chunkId) ||
        draft.excerptHash === prior.excerptHash
    );
    if (isDuplicate) continue;
    const candidate: ChatSourceEnvelopeItem = {
      ...replayToSource(documentInfo, prior),
      sourceId: `src-${String(drafts.length + 1)}`,
    };
    const candidateCost = estimateSourceEnvelopeTokens(candidate);
    if (replayTokens + candidateCost > replayBudget) break;
    const candidateXml = serializeProvenanceXml(docHeader, [...drafts, candidate]);
    if (baseTokens + estimateChatTokens(candidateXml) > contextWindow) break;
    drafts.push(candidate);
    replayTokens += candidateCost;
  }
}

function assembleBudgetBreakdown(
  systemPrompt: string,
  question: string,
  historyTokens: number,
  documentContextTokens: number,
  maxOutputTokens: number,
  finalSources: readonly ChatSourceEnvelopeItem[]
): ChatContextBudgetBreakdown {
  const excerptTokens = finalSources.reduce(
    (total, source) => total + estimateChatTokens(source.excerptText),
    0
  );
  return {
    systemPromptTokens: estimateChatTokens(systemPrompt),
    userPromptTokens: estimateChatTokens(question),
    historyTokens,
    documentContextTokens,
    documentSerializationTokens: Math.max(0, documentContextTokens - excerptTokens),
    safetyHeadroomTokens: CHAT_CONTEXT_HEADROOM_TOKENS,
    reservedResponseTokens: maxOutputTokens,
  };
}
