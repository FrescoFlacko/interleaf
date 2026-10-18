import { describe, expect, it } from 'vitest';
import { buildSnippet, queryTerms, searchDocuments, type SearchDocument } from '../../../wiki.search';

const providersText =
  'Interleaf has two AI features. The capability matrix lists every provider and what it can do. '
  + 'What leaves your machine depends on the provider you connect, and nothing is sent until you ask.';

const documents: readonly SearchDocument[] = [
  {
    route: 'ai-providers.html',
    title: 'AI providers',
    section: 'AI',
    headings: [
      {
        id: 'the-capability-matrix',
        text: 'The capability matrix',
        offset: providersText.indexOf('The capability matrix'),
      },
      {
        id: 'what-leaves-your-machine',
        text: 'What leaves your machine',
        offset: providersText.indexOf('What leaves your machine'),
      },
    ],
    text: providersText,
  },
  {
    route: 'formats/pdf.html',
    title: 'PDF',
    section: 'Your library',
    headings: [{ id: 'searching', text: 'Searching', offset: 10 }],
    text: 'A PDF keeps its fixed layout. Searching a scanned PDF finds nothing without OCR.',
  },
];

describe('query parsing', () => {
  it('splits on punctuation and de-duplicates terms', () => {
    expect(queryTerms('  Highlight, highlight; notes!  ')).toEqual(['highlight', 'notes']);
  });

  it('returns no terms for an empty query', () => {
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('searchDocuments', () => {
  it('finds pages by title', () => {
    const hits = searchDocuments(documents, 'pdf');
    expect(hits[0]?.route).toBe('formats/pdf.html');
  });

  it('finds pages by article text a title never mentions', () => {
    const hits = searchDocuments(documents, 'OCR');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.route).toBe('formats/pdf.html');
    expect(hits[0]?.snippet.some((segment) => segment.match)).toBe(true);
  });

  it('requires every term to appear somewhere in the page', () => {
    expect(searchDocuments(documents, 'ocr capability')).toEqual([]);
  });

  it('returns nothing for an empty query and for a word nobody wrote', () => {
    expect(searchDocuments(documents, '')).toEqual([]);
    expect(searchDocuments(documents, 'zzzzzz')).toEqual([]);
  });

  it('ranks a title match above a body-only match', () => {
    const hits = searchDocuments(documents, 'providers');
    expect(hits[0]?.title).toBe('AI providers');
  });

  it('links a body match to the heading it sits under', () => {
    const hits = searchDocuments(documents, 'machine');
    expect(hits[0]?.anchor).toBe('what-leaves-your-machine');
    expect(hits[0]?.headingText).toBe('What leaves your machine');
  });

  it('honours the result limit', () => {
    expect(searchDocuments(documents, 'a', 1)).toHaveLength(1);
  });
});

describe('buildSnippet', () => {
  const text = 'The quick brown fox jumps over the lazy dog while the fox watches.';

  it('marks every occurrence of the terms and keeps the passage text intact', () => {
    const segments = buildSnippet(text, ['fox'], text.indexOf('fox'));
    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(['fox', 'fox']);
    expect(segments.map((segment) => segment.text).join('').replace(/…/gu, '')).toBe(text);
  });

  it('returns plain text segments, never markup', () => {
    const risky = 'A page about <script>alert(1)</script> injection.';
    const segments = buildSnippet(risky, ['script'], risky.indexOf('script'));
    const joined = segments.map((segment) => segment.text).join('');
    expect(joined).toContain('<script>');
    expect(segments.every((segment) => typeof segment.text === 'string')).toBe(true);
  });

  it('elides the surrounding text with ellipses', () => {
    const long = `${'word '.repeat(80)}needle${' word'.repeat(80)}`;
    const segments = buildSnippet(long, ['needle'], long.indexOf('needle'));
    const joined = segments.map((segment) => segment.text).join('');
    expect(joined.startsWith('…')).toBe(true);
    expect(joined.endsWith('…')).toBe(true);
    expect(joined.length).toBeLessThan(260);
  });
});
