import type { DocumentAnchor } from './types/annotation';
import type { AgentContextPacket } from './types/agent';
import type { DocumentLocation } from './types/document';
import { AGENT_MAX_CONTEXT_PACKET_BYTES } from './schemas/agent';
import { InterleafError } from './errors/interleaf-error';
import { hasParagraphFormat, type ParagraphFormat } from './document-format-family';

/**
 * Normalize one renderer-created context packet before it crosses into the
 * main process. The exact quote is the canonical context payload; the native
 * anchor is retained only for safe location re-anchoring when a packet is
 * large enough that duplicating its quote would exceed the persisted budget.
 */
export function fitAgentContextPacketToByteBudget(
  packet: AgentContextPacket,
  sourceWasTruncated: boolean,
): AgentContextPacket {
  const byteLength = (candidate: AgentContextPacket): number => new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
  const originalTruncated = sourceWasTruncated || packet.provenance.truncated;
  if (packet.selection.anchor.format !== packet.selection.location.format) {
    throw new InterleafError('validation', 'Agent context anchor and location formats must match.');
  }
  // Do not rewrite ordinary packets. Besides avoiding unnecessary work, this
  // preserves exact native anchors and surrounding text whenever they already
  // fit the main-owned serialization limit.
  if (byteLength(packet) <= AGENT_MAX_CONTEXT_PACKET_BYTES) return packet;

  let canonicalPacket: AgentContextPacket = {
    ...packet,
    selection: {
      ...packet.selection,
      // Preserve only the format-native location. Composite segment quotes,
      // prefixes, and suffixes are redundant with exactQuote and can consume
      // the entire packet budget without improving Agent retrieval.
      anchor: locationOnlyAnchor(packet.selection.anchor.format, packet.selection.location),
    },
  };
  if (byteLength(canonicalPacket) <= AGENT_MAX_CONTEXT_PACKET_BYTES) return canonicalPacket;

  // Surrounding text is optional. Preserve the full canonical exact quote and
  // keep as much surrounding context as the remaining byte budget allows
  // before considering exact-quote truncation.
  const surroundingText = canonicalPacket.selection.surroundingText;
  if (surroundingText !== null) {
    let low = 0;
    let high = surroundingText.length;
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidateText = takeCodePointPrefix(surroundingText, middle);
      const candidate: AgentContextPacket = {
        ...canonicalPacket,
        selection: { ...canonicalPacket.selection, surroundingText: candidateText || null },
      };
      if (byteLength(candidate) <= AGENT_MAX_CONTEXT_PACKET_BYTES) {
        best = candidateText;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    canonicalPacket = {
      ...canonicalPacket,
      selection: { ...canonicalPacket.selection, surroundingText: best || null },
    };
    if (byteLength(canonicalPacket) <= AGENT_MAX_CONTEXT_PACKET_BYTES) return canonicalPacket;
  }

  const sourceText = canonicalPacket.selection.exactQuote;
  let low = 1;
  let high = sourceText.length;
  let best = takeCodePointPrefix(sourceText, 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateText = takeCodePointPrefix(sourceText, middle);
    const candidate: AgentContextPacket = {
      ...canonicalPacket,
      selection: { ...canonicalPacket.selection, exactQuote: candidateText },
      provenance: {
        ...canonicalPacket.provenance,
        truncated: true,
      },
    };
    if (byteLength(candidate) <= AGENT_MAX_CONTEXT_PACKET_BYTES) {
      best = candidateText;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    ...canonicalPacket,
    selection: { ...canonicalPacket.selection, exactQuote: best },
    provenance: {
      ...canonicalPacket.provenance,
      truncated: originalTruncated || best.length < sourceText.length,
    },
  };
}

/** Return at most `maxCodeUnits` from the start without splitting a surrogate pair. */
export function takeCodePointPrefix(text: string, maxCodeUnits: number): string {
  let end = Math.min(Math.max(maxCodeUnits, 0), text.length);
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
}

/** Return at most `maxCodeUnits` from the end without splitting a surrogate pair. */
export function takeCodePointSuffix(text: string, maxCodeUnits: number): string {
  let start = Math.max(0, text.length - Math.max(maxCodeUnits, 0));
  if (start > 0 && start < text.length) {
    const previous = text.charCodeAt(start - 1);
    const first = text.charCodeAt(start);
    if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) start += 1;
  }
  return text.slice(start);
}

type AnchorQuote = { readonly exact: string; readonly prefix: string; readonly suffix: string };

function paragraphAnchor(
  location: Extract<DocumentLocation, { readonly format: ParagraphFormat }>,
  quote: AnchorQuote
): DocumentAnchor {
  return {
    format: location.format,
    quote,
    paragraphIndex: location.paragraphIndex,
    ...(location.characterStart !== undefined && location.characterEnd !== undefined
      ? { characterStart: location.characterStart, characterEnd: location.characterEnd }
      : {}),
    ...(location.renderedPageIndex !== undefined ? { renderedPageIndex: location.renderedPageIndex } : {}),
  };
}

function locationOnlyAnchor(format: DocumentAnchor['format'], location: DocumentLocation): DocumentAnchor {
  if (format !== location.format) {
    throw new InterleafError('validation', 'Agent context anchor and location formats must match.');
  }
  const quote = { exact: '', prefix: '', suffix: '' } as const;
  if (hasParagraphFormat(location)) return paragraphAnchor(location, quote);
  switch (location.format) {
    case 'pdf':
      return {
        format: 'pdf',
        quote,
        pageIndex: location.pageIndex,
        ...(location.pageLabel !== undefined ? { pageLabel: location.pageLabel } : {}),
        ...(location.textStart !== undefined && location.textEnd !== undefined
          ? { textStart: location.textStart, textEnd: location.textEnd }
          : {}),
      };
    case 'epub':
      return {
        format: 'epub',
        quote,
        cfi: location.cfi,
        ...(location.spineHref !== undefined ? { spineHref: location.spineHref } : {}),
        ...(location.progression !== undefined ? { progression: location.progression } : {}),
        ...(location.textStart !== undefined && location.textEnd !== undefined
          ? { textStart: location.textStart, textEnd: location.textEnd }
          : {}),
      };
    case 'mobi':
      return {
        format: 'mobi',
        quote,
        sectionIndex: location.sectionIndex,
        ...(location.byteOffset !== undefined ? { byteOffset: location.byteOffset } : {}),
        ...(location.progression !== undefined ? { progression: location.progression } : {}),
        ...(location.textStart !== undefined && location.textEnd !== undefined
          ? { textStart: location.textStart, textEnd: location.textEnd }
          : {}),
      };
    case 'markdown':
      return {
        format: 'markdown',
        quote,
        blockIndex: location.blockIndex,
        ...(location.characterStart !== undefined && location.characterEnd !== undefined
          ? { characterStart: location.characterStart, characterEnd: location.characterEnd }
          : {}),
        ...(location.lineIndex !== undefined ? { lineIndex: location.lineIndex } : {}),
        ...(location.headingId !== undefined ? { headingId: location.headingId } : {}),
      };
  }
}
