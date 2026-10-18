// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  parseMarkdownDocument,
  parseMarkdownInlines,
  slugifyHeading,
  isSafeMarkdownUrl,
  type MarkdownHeadingBlock,
} from '../../src/renderer/features/reader/adapters/markdown-parser';

describe('markdown-parser', () => {
  describe('slugifyHeading', () => {
    it('lowercases, strips punctuation, and replaces whitespace', () => {
      expect(slugifyHeading('Hello World!')).toBe('hello-world');
      expect(slugifyHeading('  Chapter 1: Introduction  ')).toBe('chapter-1-introduction');
      expect(slugifyHeading('Über Café')).toBe('ber-caf');
    });

    it('collapses repeated separators', () => {
      expect(slugifyHeading('A -- B')).toBe('a-b');
      expect(slugifyHeading('foo   bar')).toBe('foo-bar');
    });
  });

  describe('isSafeMarkdownUrl', () => {
    it('allows http, https, mailto, and fragment links', () => {
      expect(isSafeMarkdownUrl('https://example.com')).toBe(true);
      expect(isSafeMarkdownUrl('http://example.com')).toBe(true);
      expect(isSafeMarkdownUrl('http://localhost:3000')).toBe(true);
      expect(isSafeMarkdownUrl('mailto:user@example.com')).toBe(true);
      expect(isSafeMarkdownUrl('#heading')).toBe(true);
    });

    it('rejects javascript, data, file, and interleaf-media schemes', () => {
      expect(isSafeMarkdownUrl('javascript:alert(1)')).toBe(false);
      expect(isSafeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
      expect(isSafeMarkdownUrl('file:///etc/passwd')).toBe(false);
      expect(isSafeMarkdownUrl('interleaf-media://asset')).toBe(false);
      expect(isSafeMarkdownUrl('vbscript:MsgBox("hi")')).toBe(false);
      expect(isSafeMarkdownUrl('ftp://files.example.com')).toBe(false);
      expect(isSafeMarkdownUrl('unknown-protocol://x')).toBe(false);
      expect(isSafeMarkdownUrl('../../../etc/passwd')).toBe(false);
    });

    it('rejects blocked schemes regardless of case', () => {
      expect(isSafeMarkdownUrl('JAVASCRIPT:alert(1)')).toBe(false);
      expect(isSafeMarkdownUrl('JavaScript:void(0)')).toBe(false);
      expect(isSafeMarkdownUrl('DATA:application/pdf;base64,abc')).toBe(false);
      expect(isSafeMarkdownUrl('FILE:///C:/Windows/System32')).toBe(false);
    });

    it('rejects schemes with whitespace padding', () => {
      expect(isSafeMarkdownUrl('  javascript:alert(1)  ')).toBe(false);
    });
  });

  describe('parseMarkdownInlines', () => {
    it('parses plain text', () => {
      const inlines = parseMarkdownInlines('Hello world');
      expect(inlines).toEqual([{ type: 'text', text: 'Hello world' }]);
    });

    it('parses inline code', () => {
      const inlines = parseMarkdownInlines('use `const x` here');
      expect(inlines).toHaveLength(3);
      expect(inlines[1]).toEqual({ type: 'code', code: 'const x' });
    });

    it('parses bold, italic, and bold-italic', () => {
      const bold = parseMarkdownInlines('**bold**');
      expect(bold[0]).toMatchObject({ type: 'strong' });

      const italic = parseMarkdownInlines('*italic*');
      expect(italic[0]).toMatchObject({ type: 'emphasis' });

      const boldItalic = parseMarkdownInlines('***both***');
      expect(boldItalic[0]).toMatchObject({ type: 'strong' });
    });

    it('parses strikethrough', () => {
      const inlines = parseMarkdownInlines('~~deleted~~');
      expect(inlines[0]).toMatchObject({ type: 'strikethrough' });
    });

    it('parses links with title', () => {
      const inlines = parseMarkdownInlines('[click](https://example.com "Example")');
      expect(inlines[0]).toMatchObject({
        type: 'link',
        href: 'https://example.com',
        title: 'Example',
      });
    });

    it('parses images', () => {
      const inlines = parseMarkdownInlines('![alt text](https://example.com/img.png)');
      expect(inlines[0]).toMatchObject({
        type: 'image',
        alt: 'alt text',
        src: 'https://example.com/img.png',
      });
    });

    it('treats raw HTML tags as inert html_text nodes', () => {
      const inlines = parseMarkdownInlines('<script>alert(1)</script>');
      const htmlNodes = inlines.filter((n) => n.type === 'html_text');
      expect(htmlNodes.length).toBeGreaterThan(0);
      // The actual script content appears as text, tags as html_text
      const allText = inlines.map((n) => {
        if (n.type === 'html_text') return n.raw;
        if (n.type === 'text') return n.text;
        return '';
      }).join('');
      expect(allText).toContain('script');
    });

    it('parses escaped characters', () => {
      const inlines = parseMarkdownInlines('\\*not italic\\*');
      expect(inlines[0]).toMatchObject({ type: 'text', text: '*' });
    });

    it('parses autolinks', () => {
      const inlines = parseMarkdownInlines('<https://example.com>');
      expect(inlines[0]).toMatchObject({ type: 'link', href: 'https://example.com' });
    });

    it('bounds inline recursion nesting depth to prevent stack overflow', () => {
      let deepText = 'hello';
      for (let i = 0; i < 50; i++) {
        deepText = `*${deepText}*`;
      }
      const inlines = parseMarkdownInlines(deepText);
      expect(inlines.length).toBeGreaterThan(0);
    });
  });

  describe('parseMarkdownDocument', () => {
    it('parses ATX headings into semantic heading blocks', () => {
      const doc = parseMarkdownDocument('# Title\n## Subtitle\n### Section');
      const headings = doc.blocks.filter((b) => b.type === 'heading');
      expect(headings).toHaveLength(3);
      expect(headings[0]).toMatchObject({ level: 1, text: 'Title' });
      expect(headings[1]).toMatchObject({ level: 2, text: 'Subtitle' });
      expect(headings[2]).toMatchObject({ level: 3, text: 'Section' });
    });

    it('derives title from frontmatter', () => {
      const doc = parseMarkdownDocument('---\ntitle: "My Document"\n---\n\nContent');
      expect(doc.title).toBe('My Document');
    });

    it('derives title from first H1 when no frontmatter', () => {
      const doc = parseMarkdownDocument('# First Heading\n\nSome text');
      expect(doc.title).toBe('First Heading');
    });

    it('strips BOM from document start', () => {
      const doc = parseMarkdownDocument('\uFEFF# BOM Title\n');
      expect(doc.title).toBe('BOM Title');
    });

    it('parses fenced code blocks with language', () => {
      const doc = parseMarkdownDocument('```python\nprint("hello")\n```');
      const codeBlock = doc.blocks.find((b) => b.type === 'code_block');
      expect(codeBlock).toBeDefined();
      if (codeBlock?.type === 'code_block') {
        expect(codeBlock.language).toBe('python');
        expect(codeBlock.code).toBe('print("hello")');
      }
    });

    it('parses blockquotes', () => {
      const doc = parseMarkdownDocument('> This is quoted\n> More quote');
      const bq = doc.blocks.find((b) => b.type === 'blockquote');
      expect(bq).toBeDefined();
      if (bq?.type === 'blockquote') {
        expect(bq.text).toContain('This is quoted');
      }
    });

    it('parses horizontal rules', () => {
      const doc = parseMarkdownDocument('---\n\n***\n\n___');
      const hrs = doc.blocks.filter((b) => b.type === 'hr');
      // First --- may be consumed as frontmatter boundary or hr depending on context
      expect(hrs.length).toBeGreaterThanOrEqual(2);
    });

    it('parses unordered lists', () => {
      const doc = parseMarkdownDocument('- item one\n- item two\n- item three');
      const list = doc.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
      if (list?.type === 'list') {
        expect(list.list.ordered).toBe(false);
        expect(list.list.items).toHaveLength(3);
      }
    });

    it('parses ordered lists', () => {
      const doc = parseMarkdownDocument('1. first\n2. second');
      const list = doc.blocks.find((b) => b.type === 'list');
      expect(list).toBeDefined();
      if (list?.type === 'list') {
        expect(list.list.ordered).toBe(true);
        expect(list.list.items).toHaveLength(2);
      }
    });

    it('parses task lists', () => {
      const doc = parseMarkdownDocument('- [x] done\n- [ ] pending');
      const list = doc.blocks.find((b) => b.type === 'list');
      if (list?.type === 'list') {
        expect(list.list.items[0]?.checked).toBe(true);
        expect(list.list.items[1]?.checked).toBe(false);
      }
    });

    it('parses GFM pipe tables', () => {
      const doc = parseMarkdownDocument(
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
      );
      const table = doc.blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table?.type === 'table') {
        expect(table.table.headers).toHaveLength(2);
        expect(table.table.rows).toHaveLength(2);
      }
    });

    it('deduplicates heading IDs for repeated headings', () => {
      const doc = parseMarkdownDocument('# Intro\n## Intro\n## Intro');
      const headings = doc.blocks.filter((b): b is MarkdownHeadingBlock => b.type === 'heading');
      const ids = headings.map((h) => h.headingId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('assigns sequential block indexes', () => {
      const doc = parseMarkdownDocument('# A\n\nParagraph\n\n## B');
      const indexes = doc.blocks.map((b) => b.index);
      expect(indexes).toEqual([0, 1, 2]);
    });

    it('handles empty document', () => {
      const doc = parseMarkdownDocument('');
      expect(doc.blocks).toHaveLength(0);
      expect(doc.title).toBeNull();
    });

    it('parses paragraphs with continued lines', () => {
      const doc = parseMarkdownDocument('First line\nContinued line\n\nNew paragraph');
      const paragraphs = doc.blocks.filter((b) => b.type === 'paragraph');
      expect(paragraphs).toHaveLength(2);
    });

    it('parses Setext H1 (===) and H2 (---) headings', () => {
      const doc = parseMarkdownDocument(
        'Main Title\n===========\n\nIntroductory paragraph.\n\nSection Title\n-------------\n\nSection body.'
      );
      expect(doc.title).toBe('Main Title');
      expect(doc.blocks).toHaveLength(4);

      const h1 = doc.blocks[0] as MarkdownHeadingBlock;
      expect(h1.type).toBe('heading');
      expect(h1.level).toBe(1);
      expect(h1.text).toBe('Main Title');
      expect(h1.headingId).toBe('main-title');

      const p1 = doc.blocks[1];
      expect(p1?.type).toBe('paragraph');

      const h2 = doc.blocks[2] as MarkdownHeadingBlock;
      expect(h2.type).toBe('heading');
      expect(h2.level).toBe(2);
      expect(h2.text).toBe('Section Title');
      expect(h2.headingId).toBe('section-title');
    });

    it('does not confuse horizontal rules with Setext headings', () => {
      const doc = parseMarkdownDocument('---\n\nParagraph text\n\n---');
      expect(doc.blocks).toHaveLength(3);
      expect(doc.blocks[0]?.type).toBe('hr');
      expect(doc.blocks[1]?.type).toBe('paragraph');
      expect(doc.blocks[2]?.type).toBe('hr');
    });

    it('enforces maximum document byte limit and line count limit', () => {
      const hugeDoc = 'a\n'.repeat(100_005);
      expect(() => parseMarkdownDocument(hugeDoc)).toThrow(/line count limit/);
    });
  });
});
