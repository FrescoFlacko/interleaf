/**
 * Search logic for the generated wiki website.
 *
 * It runs in the browser against the index emitted by `wiki.build.ts`, and is
 * deliberately free of DOM access so it can be unit tested directly. Matches are
 * returned as plain text segments; the caller renders them as text nodes, so
 * indexed prose can never become markup.
 */

export type SearchHeading = {
  readonly id: string;
  readonly text: string;
  readonly offset: number;
};

export type SearchDocument = {
  readonly route: string;
  readonly title: string;
  readonly section: string;
  readonly headings: readonly SearchHeading[];
  readonly text: string;
};

export type SnippetSegment = {
  readonly text: string;
  readonly match: boolean;
};

export type SearchHit = {
  readonly route: string;
  readonly title: string;
  readonly section: string;
  /** Heading the match sits under, so a result can deep-link into the page. */
  readonly anchor: string | null;
  readonly headingText: string | null;
  readonly snippet: readonly SnippetSegment[];
  readonly score: number;
};

const TITLE_WEIGHT = 14;
const HEADING_WEIGHT = 6;
const BODY_WEIGHT = 1;
const MAX_BODY_MATCHES = 8;
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 150;

/** Splits a raw query into the terms every result has to contain. */
export function queryTerms(query: string): readonly string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
  return [...new Set(terms)].slice(0, 8);
}

function countOccurrences(haystack: string, needle: string, limit: number): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < limit) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function headingForOffset(
  headings: readonly SearchHeading[],
  offset: number,
): SearchHeading | null {
  let found: SearchHeading | null = null;
  for (const heading of headings) {
    if (heading.offset <= offset) found = heading;
    else break;
  }
  return found;
}

function expandLeft(text: string, index: number): number {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  if (start === 0) return 0;
  const space = text.indexOf(' ', start);
  return space === -1 || space >= index ? start : space + 1;
}

function expandRight(text: string, index: number): number {
  const end = Math.min(text.length, index + SNIPPET_AFTER);
  if (end === text.length) return end;
  const space = text.lastIndexOf(' ', end);
  return space <= index ? end : space;
}

/** Splits a passage into plain and matching segments, in order. */
export function buildSnippet(
  text: string,
  terms: readonly string[],
  center: number,
): readonly SnippetSegment[] {
  const start = expandLeft(text, center);
  const end = expandRight(text, center);
  const passage = text.slice(start, end);
  const lower = passage.toLowerCase();
  const marks: { start: number; end: number }[] = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      marks.push({ start: index, end: index + term.length });
      index = lower.indexOf(term, index + term.length);
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const segments: SnippetSegment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) segments.push({ text: passage.slice(cursor, mark.start), match: false });
    segments.push({ text: passage.slice(mark.start, mark.end), match: true });
    cursor = mark.end;
  }
  if (cursor < passage.length) segments.push({ text: passage.slice(cursor), match: false });
  if (start > 0 && segments.length > 0) {
    const first = segments[0];
    if (first !== undefined) segments[0] = { text: `…${first.text}`, match: first.match };
  }
  if (end < text.length && segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last !== undefined) segments[segments.length - 1] = { text: `${last.text}…`, match: last.match };
  }
  return segments;
}

type Scored = {
  readonly score: number;
  readonly center: number;
};

function scoreDocument(document: SearchDocument, terms: readonly string[]): Scored | null {
  const title = document.title.toLowerCase();
  const text = document.text.toLowerCase();
  const headingText = document.headings.map((heading) => heading.text.toLowerCase()).join(' \u0000 ');
  let score = 0;
  let center = -1;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inHeading = headingText.includes(term);
    const bodyHits = countOccurrences(text, term, MAX_BODY_MATCHES);
    if (!inTitle && !inHeading && bodyHits === 0) return null;
    if (inTitle) score += TITLE_WEIGHT;
    if (inHeading) score += HEADING_WEIGHT;
    score += bodyHits * BODY_WEIGHT;
    const position = text.indexOf(term);
    if (position !== -1 && (center === -1 || position < center)) center = position;
  }
  return { score, center: center === -1 ? 0 : center };
}

/** Ranks documents against a query; an empty query returns no results. */
export function searchDocuments(
  documents: readonly SearchDocument[],
  query: string,
  limit = 8,
): readonly SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const document of documents) {
    const scored = scoreDocument(document, terms);
    if (scored === null) continue;
    const heading = headingForOffset(document.headings, scored.center);
    hits.push({
      route: document.route,
      title: document.title,
      section: document.section,
      anchor: heading?.id ?? null,
      headingText: heading?.text ?? null,
      snippet: buildSnippet(document.text, terms, scored.center),
      score: scored.score,
    });
  }
  hits.sort((a, b) => (b.score - a.score) || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}
