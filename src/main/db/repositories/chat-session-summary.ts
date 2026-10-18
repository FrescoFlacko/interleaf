import { Marked, type Token, type Tokens } from 'marked';
import { CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS } from '@shared/constants/ai';
import { CITATION_MARKER_PATTERN, chatCitationLabel } from '@shared/chat-citation-label';
import { parsePortableJson, type PortableValue } from '@shared/models/portable';
import type { ChatCitation } from '@shared/types/ai';

/**
 * Derived summary columns shared by every session read path: the stored message
 * count and the most recent stored user/assistant message text, with that same
 * message's citation envelope. All come from `chat_messages`, so a session list
 * never reports a count or an excerpt that the conversation does not contain.
 */
const LATEST_PREVIEW_MESSAGE = `
                FROM chat_messages m
               WHERE m.session_id = s.id
                 AND m.role IN ('user', 'assistant')
                 AND TRIM(m.content) <> ''
               ORDER BY m.ordinal DESC
               LIMIT 1`;

export const SESSION_SUMMARY_COLUMNS = `
             (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
             (SELECT m.content${LATEST_PREVIEW_MESSAGE}) AS preview_text,
             (SELECT m.citation_json${LATEST_PREVIEW_MESSAGE}) AS preview_citation_json`;

/**
 * The citations a preview may label. A preview is a convenience, so an envelope
 * that cannot be read labels nothing rather than failing the whole list; the
 * conversation itself still validates it strictly when opened.
 */
function previewCitations(value: string | undefined): ReadonlyMap<string, ChatCitation> {
  const citations = new Map<string, ChatCitation>();
  if (value === undefined) return citations;
  let parsed: PortableValue;
  try {
    parsed = parsePortableJson(value);
  } catch {
    return citations;
  }
  if (!Array.isArray(parsed)) return citations;
  for (const item of parsed as PortableValue[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { sourceId, label, pageLabel, heading } = item as Record<string, PortableValue>;
    if (typeof sourceId !== 'string' || typeof label !== 'string') continue;
    citations.set(sourceId, {
      sourceId,
      label,
      pageLabel: typeof pageLabel === 'string' ? pageLabel : null,
      heading: typeof heading === 'string' ? heading : null,
    });
  }
  return citations;
}

/** The conversation's own Markdown dialect, used here only to find its code. */
const previewMarkdown = new Marked({ gfm: true, breaks: true });

type SourceRange = readonly [start: number, end: number];

/**
 * Tokens the conversation shows verbatim, never as cited prose: code, images,
 * and a link's destination and title (only its text is prose).
 */
function isLiteral(token: Token): boolean {
  return token.type === 'code' || token.type === 'codespan' || token.type === 'image' || token.type === 'link';
}

function containsLiteral(token: Token): boolean {
  let found = false;
  void previewMarkdown.walkTokens([token], (child) => {
    if (isLiteral(child)) found = true;
  });
  return found;
}

function childTokens(token: Token): readonly Token[] | undefined {
  if (token.type === 'list') return (token as Tokens.List).items;
  return 'tokens' in token ? token.tokens : undefined;
}

/**
 * Adds the literal ranges of one token that starts at `start` in the source.
 * A token's children follow one another in its raw text after its opening
 * markup (`# `, `**`, `[`), so they are placed as one consecutive run, and
 * only where that run occurs exactly once in the token. Each child then starts
 * where the previous one ended, so an earlier sibling's text (a link title
 * that repeats a later code span, say) can never be mistaken for a later
 * one. Where markup rewrites the children (a quote's `>` prefixes, a list
 * item's indent) or the run repeats, the whole token is kept verbatim rather
 * than guessed at.
 */
function addLiteralRanges(token: Token, start: number, ranges: SourceRange[]): void {
  const end = start + token.raw.length;
  if (token.type === 'code' || token.type === 'codespan' || token.type === 'image') {
    ranges.push([start, end]);
    return;
  }
  if (!containsLiteral(token)) return;
  const children = childTokens(token) ?? [];
  const run = children.map((child) => child.raw).join('');
  // A quote or list item strips each line's prefix from its children, so
  // children spanning lines are not the source text even if a match exists.
  const rewritten = (token.type === 'blockquote' || token.type === 'list_item') && run.trimEnd().includes('\n');
  const at = run.length === 0 || rewritten ? -1 : token.raw.indexOf(run);
  if (at < 0 || token.raw.includes(run, at + 1)) {
    ranges.push([start, end]);
    return;
  }
  let cursor = start + at;
  for (const child of children) {
    addLiteralRanges(child, cursor, ranges);
    cursor += child.raw.length;
  }
  // A link's destination and title follow its text.
  if (token.type === 'link' && cursor < end) ranges.push([cursor, end]);
}

/**
 * Source ranges the conversation renders verbatim: fenced (backtick or
 * tilde), indented and inline code, with delimiter runs paired as Markdown
 * pairs them, plus images and link destinations. Anything the lexer cannot
 * place exactly is treated as verbatim, so a preview never labels text the
 * conversation would show literally.
 */
function literalRanges(content: string): SourceRange[] {
  let blocks;
  try {
    blocks = previewMarkdown.lexer(content);
  } catch {
    return [[0, content.length]];
  }
  const ranges: SourceRange[] = [];
  let offset = 0;
  for (const token of blocks) {
    if (content.slice(offset, offset + token.raw.length) !== token.raw) return [...ranges, [offset, content.length]];
    addLiteralRanges(token, offset, ranges);
    offset += token.raw.length;
  }
  return ranges;
}

/** Shows each envelope-named marker outside code by its label; the rest stays as written. */
function labelCitations(content: string, citations: ReadonlyMap<string, ChatCitation>): string {
  const label = (text: string): string => text.replace(CITATION_MARKER_PATTERN, (marker, sourceId: string) => {
    const citation = citations.get(sourceId);
    return citation === undefined ? marker : `(${chatCitationLabel(citation)})`;
  });
  let labelled = '';
  let cursor = 0;
  for (const [start, end] of literalRanges(content)) {
    labelled += label(content.slice(cursor, start)) + content.slice(start, end);
    cursor = end;
  }
  return labelled + label(content.slice(cursor));
}

/**
 * Collapses the latest stored message into the bounded single-line excerpt
 * shown on conversation cards. A marker that message's own envelope names is
 * shown by its label, as the conversation shows it; any other bracketed text is
 * left exactly as written. Returns `null` rather than an empty or invented
 * string when the session has no usable message text.
 */
export function sessionPreview(
  content: string | null | undefined,
  citationJson: string | null | undefined,
): string | null {
  if (typeof content !== 'string') return null;
  // Markdown reads `\r\n` as `\n`; normalising first keeps code offsets exact.
  const source = content.replace(/\r\n?/gu, '\n');
  const labelled = labelCitations(source, previewCitations(citationJson ?? undefined));
  const collapsed = labelled.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS) return collapsed;
  return `${collapsed.slice(0, CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS - 1).trimEnd()}…`;
}
