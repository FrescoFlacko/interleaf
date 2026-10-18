import { describe, expect, it } from 'vitest';
import {
  assetPrefix,
  embeddableJson,
  escapeHtml,
  relativeHref,
  renderMarkdown,
  resolveLink,
  routeForSource,
  slugify,
} from '../../../wiki.build';

const render = (markdown: string): string => renderMarkdown(markdown);

const routes = new Map<string, string>([
  ['wiki/README.md', 'index.html'],
  ['wiki/ai-chat.md', 'ai-chat.html'],
  ['wiki/formats/README.md', 'formats/index.html'],
  ['wiki/formats/pdf.md', 'formats/pdf.html'],
  ['wiki/providers/pi.md', 'providers/pi.html'],
  ['ARCHITECTURE.md', 'project/architecture.html'],
]);

const context = (source: string, route: string) => ({ source, route, routes });

describe('wiki markdown rendering', () => {
  it('escapes raw HTML instead of letting it become markup', () => {
    const html = render('Text with <script>alert(1)</script> inside.\n');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps prose that merely looks like an HTML tag', () => {
    // `<title>` would otherwise be parsed as an element and swallow the rest
    // of the sentence.
    const html = render('you will see *"<title>" is already in your library.*\n');
    expect(html).toContain('&lt;title&gt;');
    expect(html).toContain('already in your library');
  });

  it('keeps the keyboard markup the wiki uses', () => {
    expect(render('Press <kbd>Enter</kbd>.\n')).toContain('<kbd>Enter</kbd>');
  });

  it('drops javascript: and data: link targets', () => {
    const html = render('[x](javascript:alert(1)) [y](data:text/html;base64,PHNjcmlwdD4=)\n');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
  });

  it('never emits event handlers or embedded frames as markup', () => {
    const html = render('<div onclick="steal()">hi</div>\n\n<iframe src="https://evil.test"></iframe>\n');
    expect(html).not.toContain('<div');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;div onclick');
  });

  it('renders GitHub tables and fenced code', () => {
    const html = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```bash\nnpm run dev\n```\n');
    expect(html).toContain('<table>');
    expect(html).toContain('language-bash');
  });
});

describe('routes and links', () => {
  it('maps sources to routes', () => {
    expect(routeForSource('wiki/README.md')).toBe('index.html');
    expect(routeForSource('wiki/formats/README.md')).toBe('formats/index.html');
    expect(routeForSource('wiki/providers/pi.md')).toBe('providers/pi.html');
    expect(routeForSource('ARCHITECTURE.md')).toBe('project/architecture.html');
  });

  it('computes asset prefixes for nested routes', () => {
    expect(assetPrefix('index.html')).toBe('');
    expect(assetPrefix('formats/pdf.html')).toBe('../');
  });

  it('computes relative hrefs between routes', () => {
    expect(relativeHref('providers/pi.html', 'ai-chat.html')).toBe('../ai-chat.html');
    expect(relativeHref('index.html', 'formats/pdf.html')).toBe('formats/pdf.html');
    expect(relativeHref('providers/pi.html', 'providers/omp.html')).toBe('omp.html');
  });

  it('resolves sibling, parent and fragment Markdown links', () => {
    expect(resolveLink('ai-chat.md', context('wiki/README.md', 'index.html')))
      .toEqual({ kind: 'internal', href: 'ai-chat.html' });
    expect(resolveLink('../ai-chat.md#web-search', context('wiki/providers/pi.md', 'providers/pi.html')))
      .toEqual({ kind: 'internal', href: '../ai-chat.html#web-search' });
    expect(resolveLink('README.md', context('wiki/formats/pdf.md', 'formats/pdf.html')))
      .toEqual({ kind: 'internal', href: 'index.html' });
    expect(resolveLink('#section', context('wiki/ai-chat.md', 'ai-chat.html')))
      .toEqual({ kind: 'internal', href: '#section' });
  });

  it('resolves links that leave the wiki to their rendered page', () => {
    expect(resolveLink('../ARCHITECTURE.md', context('wiki/README.md', 'index.html')))
      .toEqual({ kind: 'internal', href: 'project/architecture.html' });
  });

  it('reports targets with no page instead of inventing a route', () => {
    expect(resolveLink('../decisions/ADR-0007.md', context('wiki/README.md', 'index.html')))
      .toEqual({ kind: 'unresolved', target: 'decisions/ADR-0007.md' });
    expect(resolveLink('javascript:alert(1)', context('wiki/README.md', 'index.html')))
      .toEqual({ kind: 'unresolved', target: 'javascript:alert(1)' });
    expect(resolveLink('', context('wiki/README.md', 'index.html')))
      .toEqual({ kind: 'unresolved', target: '' });
  });

  it('treats http(s) and mailto as external', () => {
    expect(resolveLink('https://omp.sh', context('wiki/README.md', 'index.html')).kind).toBe('external');
    expect(resolveLink('mailto:a@b.test', context('wiki/README.md', 'index.html')).kind).toBe('external');
  });
});

describe('text helpers', () => {
  it('slugifies headings the way the Markdown anchors expect', () => {
    expect(slugify('The capability matrix')).toBe('the-capability-matrix');
    expect(slugify('Install from a Windows `.exe`')).toBe('install-from-a-windows-exe');
    expect(slugify('MOBI, AZW and AZW3 (Kindle)')).toBe('mobi-azw-and-azw3-kindle');
    expect(slugify('1. Launch Interleaf')).toBe('1-launch-interleaf');
  });

  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('produces JSON that cannot close a script element', () => {
    const json = embeddableJson({ text: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('</script');
    expect(json).toContain('\\u003c');
    expect(JSON.parse(json)).toEqual({ text: '</script><script>alert(1)</script>' });
  });
});
