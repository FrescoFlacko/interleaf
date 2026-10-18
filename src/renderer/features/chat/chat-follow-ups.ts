import type { ChatCitation, ChatContextItem, ChatMessage } from '@shared/types/ai';

/**
 * Renderer-derived next steps for Reader Chat (DESIGN.md, Pattern 1 and 2).
 *
 * Everything here is a pure function of data the panel already holds: the open
 * document's title, the pinned context, and the latest answer with its
 * citations. Nothing calls a model, and every result is a draft for the
 * composer, never a request. Answer text is untrusted, so the terms lifted
 * from it are stripped of Markdown and bounded, and they are only ever shown
 * as text or placed in the composer.
 */

type ChatSuggestionKind = 'zoom-in' | 'zoom-out' | 'action' | 'retry';

export type ChatSuggestion = {
  readonly kind: ChatSuggestionKind;
  /** Short, scannable chip text. */
  readonly label: string;
  /** Why the suggestion is offered, in transitional phrasing. */
  readonly reason: string;
  /** The full prompt the chip places in the composer. */
  readonly prompt: string;
};

export type ChatStarter = {
  readonly label: string;
  readonly prompt: string;
};

const MAX_TERM_LENGTH = 48;
const MAX_TERMS = 6;
const MAX_CONTEXT_LABELS = 3;

/** Strips inline Markdown and citation markers so a term reads as plain words. */
function plainTerm(value: string): string {
  return value
    .replace(/\[[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\]/gu, '')
    .replace(/[*_`~#>[\]()]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.:;,!?-]+$/u, '');
}

function boundTerm(value: string): string {
  return value.length <= MAX_TERM_LENGTH ? value : `${value.slice(0, MAX_TERM_LENGTH - 1).trimEnd()}…`;
}

function termsFromPattern(content: string, pattern: RegExp): string[] {
  return Array.from(content.matchAll(pattern), (match) => plainTerm(match[1] ?? ''));
}

/**
 * The answer's own vocabulary, in reading order: headings first, then bold
 * terms, then cited section headings. Deduplicated without regard to case, and
 * limited so a long answer cannot produce an unbounded list.
 */
export function answerTerms(content: string, citations: readonly ChatCitation[]): readonly string[] {
  const candidates = [
    ...termsFromPattern(content, /^\s{0,3}#{1,6}\s+(.+)$/gmu),
    ...termsFromPattern(content, /\*\*([^*\n]{2,80})\*\*/gu),
    ...citations.map((citation) => plainTerm(citation.heading ?? '')),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (candidate.length < 2 || seen.has(key)) continue;
    seen.add(key);
    terms.push(boundTerm(candidate));
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

function quoted(title: string): string {
  return `“${boundTerm(plainTerm(title)) || 'this document'}”`;
}

function contextLabels(items: readonly ChatContextItem[]): string {
  const labels = items.slice(0, MAX_CONTEXT_LABELS).map((item) => item.displayLabel);
  const more = items.length > MAX_CONTEXT_LABELS ? ` and ${String(items.length - MAX_CONTEXT_LABELS)} more` : '';
  return `${labels.join(', ')}${more}`;
}

/** Pages when every attached item is a page range, context otherwise. */
function contextNoun(items: readonly ChatContextItem[]): string {
  return items.every((item) => item.kind === 'range') ? 'pages' : 'context';
}

/** Context items the reader attached, excluding the whole-document toggle. */
function scopedContext(items: readonly ChatContextItem[]): readonly ChatContextItem[] {
  return items.filter((item) => item.kind !== 'entire_document');
}

/**
 * Starter prompts for an empty thread, grounded in the open document and, when
 * the reader has attached something, in that attachment.
 */
export function chatStarters(documentTitle: string, contextItems: readonly ChatContextItem[]): readonly ChatStarter[] {
  const title = quoted(documentTitle);
  const starters: ChatStarter[] = [
    {
      label: 'Summarize this document',
      prompt: `Summarize ${title} in a few short paragraphs, citing the pages you draw on.`,
    },
    {
      label: 'Explain the key ideas',
      prompt: `Explain the key ideas of ${title} in plain language, with a citation for each.`,
    },
    {
      label: 'Outline the argument',
      prompt: `Outline the argument of ${title} step by step, citing where each step appears.`,
    },
  ];
  const scoped = scopedContext(contextItems);
  if (scoped.length > 0) {
    const noun = contextNoun(scoped);
    starters.push({
      label: `Explain the attached ${noun}`,
      prompt: `Explain the attached ${noun} (${contextLabels(scoped)}) and how they fit into ${title}.`,
    });
  }
  return starters;
}

type FollowUpInput = {
  readonly answer: string;
  readonly citations: readonly ChatCitation[];
  readonly contextItems: readonly ChatContextItem[];
  readonly documentTitle: string;
};

function zoomInCandidates(input: FollowUpInput, terms: readonly string[]): ChatSuggestion[] {
  const fromTerms = terms.map((term): ChatSuggestion => ({
    kind: 'zoom-in',
    label: `More on “${term}”`,
    reason: 'Goes deeper on a term from this answer',
    prompt: `Go deeper on “${term}” from your last answer. What exactly does the document say about it? Cite the pages.`,
  }));
  const fromCitations = input.citations.slice(0, MAX_CONTEXT_LABELS).map((citation): ChatSuggestion => ({
    kind: 'zoom-in',
    label: `Detail from ${boundTerm(citation.label)}`,
    reason: 'Goes deeper on a source this answer cited',
    prompt: `Walk me through what ${citation.label} says in more detail, quoting the key sentences.`,
  }));
  const fallback: ChatSuggestion = {
    kind: 'zoom-in',
    label: 'Go deeper',
    reason: 'Goes deeper on this answer',
    prompt: 'Expand on the most important point of your last answer with more detail from the document.',
  };
  const candidates = [...fromTerms, ...fromCitations];
  return candidates.length > 0 ? candidates : [fallback];
}

function zoomOutCandidates(input: FollowUpInput, terms: readonly string[]): ChatSuggestion[] {
  const title = quoted(input.documentTitle);
  const scoped = scopedContext(input.contextItems);
  const candidates: ChatSuggestion[] = [{
    kind: 'zoom-out',
    label: 'How this fits the whole',
    reason: 'Steps back to the whole document',
    prompt: `How does your last answer fit into the overall argument of ${title}?`,
  }];
  if (scoped.length > 0) {
    const noun = contextNoun(scoped);
    candidates.push({
      kind: 'zoom-out',
      label: `Attached ${noun} in context`,
      reason: `Relates the attached ${noun} to the rest of the document`,
      prompt: `How do the attached ${noun} (${contextLabels(scoped)}) relate to the rest of ${title}?`,
    });
  }
  const [first, second] = terms;
  if (first !== undefined && second !== undefined) {
    candidates.push({
      kind: 'zoom-out',
      label: `Compare “${first}” and “${second}”`,
      reason: 'Compares two ideas from this answer',
      prompt: `Compare “${first}” and “${second}” from your last answer: how are they related, and where do they differ?`,
    });
  }
  return candidates;
}

function actionCandidates(input: FollowUpInput): ChatSuggestion[] {
  const candidates: ChatSuggestion[] = [
    {
      kind: 'action',
      label: 'Turn into a study note',
      reason: 'Turns this answer into something to keep',
      prompt: 'Rewrite your last answer as a short study note with bullet points and page citations.',
    },
    {
      kind: 'action',
      label: 'Quiz me on this',
      reason: 'Checks understanding of this answer',
      prompt: 'Write three questions that test my understanding of your last answer, with answers cited to the document.',
    },
    {
      kind: 'action',
      label: 'List key terms',
      reason: 'Collects the vocabulary of this answer',
      prompt: 'List the key terms from your last answer, each with a one-line definition and a page citation.',
    },
  ];
  if (input.citations.length > 0) {
    candidates.push({
      kind: 'action',
      label: 'Quote the cited passages',
      reason: 'Shows the exact text behind the citations',
      prompt: 'Quote the exact passages you cited in your last answer, each with its page.',
    });
  }
  return candidates;
}

function pick(candidates: readonly ChatSuggestion[], rotation: number): ChatSuggestion | undefined {
  if (candidates.length === 0) return undefined;
  return candidates[((rotation % candidates.length) + candidates.length) % candidates.length];
}

/**
 * At most three follow-ups for a completed answer: one zoom-in, one zoom-out
 * and one action nudge. `rotation` selects a different grounded set; the action
 * list always has more than one entry, so each step of the rotation changes
 * the set the reader sees.
 */
export function deriveChatFollowUps(input: FollowUpInput, rotation = 0): readonly ChatSuggestion[] {
  const terms = answerTerms(input.answer, input.citations);
  return [
    pick(zoomInCandidates(input, terms), rotation),
    pick(zoomOutCandidates(input, terms), rotation),
    pick(actionCandidates(input), rotation),
  ].filter((suggestion): suggestion is ChatSuggestion => suggestion !== undefined);
}

/** The retry nudge offered instead of follow-ups on a failed or stopped answer. */
export function retrySuggestion(previousPrompt: string): ChatSuggestion {
  return {
    kind: 'retry',
    label: 'Retry',
    reason: 'The last answer did not finish',
    prompt: previousPrompt,
  };
}

/**
 * The user prompt that produced the assistant message at `index`: the nearest
 * user turn before it. Null when the transcript holds none.
 */
export function precedingUserPrompt(messages: readonly ChatMessage[], index: number): string | null {
  for (let cursor = Math.min(index, messages.length) - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === 'user') return message.content;
  }
  return null;
}

export type LatestAnswerState =
  | { readonly kind: 'none' }
  | { readonly kind: 'complete'; readonly message: ChatMessage }
  | { readonly kind: 'retry'; readonly prompt: string };

/**
 * What the end of the thread offers next. Only the final message counts, and
 * only once it has settled: a streaming answer offers nothing.
 */
export function latestAnswerState(messages: readonly ChatMessage[], isStreaming: boolean): LatestAnswerState {
  const last = messages.at(-1);
  if (isStreaming || last?.role !== 'assistant') return { kind: 'none' };
  if (last.status === 'complete') {
    return last.content.trim().length > 0 ? { kind: 'complete', message: last } : { kind: 'none' };
  }
  if (last.status === 'streaming') return { kind: 'none' };
  const prompt = precedingUserPrompt(messages, messages.length - 1);
  return prompt === null ? { kind: 'none' } : { kind: 'retry', prompt };
}
