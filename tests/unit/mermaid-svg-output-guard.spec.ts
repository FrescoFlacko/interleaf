import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MERMAID_LIMITS } from '@shared/schemas/mermaid';
import { assertInertSvg } from '../../src/main/documents/mermaid/svg-output-guard';

const OPTIONS = { maxLength: MERMAID_LIMITS.maxSvgLength };

function verdict(markup: string): string {
  const result = assertInertSvg(markup, OPTIONS);
  return result.ok ? 'ok' : result.violation;
}

/**
 * Drawings produced by the pinned library in the isolated renderer and captured
 * verbatim. They are what the guard has to accept in practice, so a rule that
 * is too blunt fails here rather than in a reader.
 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, '../fixtures/mermaid', name), 'utf8');
}

describe('inert SVG guard: real renderer output', () => {
  it.each([
    'flowchart-rendered.svg',
    'sequence-rendered.svg',
    'er-rendered.svg',
    'hostile-source-rendered.svg',
  ])('reaches a decision without crashing for %s', (name) => {
    expect(() => assertInertSvg(fixture(name), OPTIONS)).not.toThrow();
  });

  it.each(['flowchart-rendered.svg', 'sequence-rendered.svg', 'er-rendered.svg'])(
    'accepts the sanitized drawing of %s',
    (name) => {
      expect(verdict(fixture(name))).toBe('ok');
    }
  );

  it('accepts a diagram whose accessible description merely contains the word "script"', () => {
    const markup = fixture('flowchart-rendered.svg');
    expect(markup).toContain('aria-roledescription="flowchart-v2"');
    expect(verdict(markup)).toBe('ok');
  });

  it('accepts same-document marker references while carrying no remote one', () => {
    const markup = fixture('flowchart-rendered.svg');
    expect(markup).toMatch(/url\(#/);
    expect(verdict(markup)).toBe('ok');
  });

  it('carries nothing active out of a hostile source', () => {
    const markup = fixture('hostile-source-rendered.svg');
    // The source asked for an HTML label, a `javascript:` click, and an
    // external link target. None of the three survived the renderer's
    // allow-list rebuild.
    expect(markup).not.toMatch(/<script|<foreignObject|onerror|javascript:/i);
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toMatch(/<a[\s>]/);
  });
});

describe('inert SVG guard: refusals', () => {
  it('refuses empty and oversized markup', () => {
    expect(verdict('')).toBe('empty');
    expect(assertInertSvg('<svg></svg>', { maxLength: 4 })).toEqual({
      ok: false,
      violation: 'too-large',
    });
  });

  it.each([
    ['<!DOCTYPE svg><svg></svg>', 'doctype'],
    ['<svg><!ENTITY x "y"></svg>', 'dtd-declaration'],
    ['<?xml version="1.0"?><svg></svg>', 'processing-instruction'],
    ['<svg><!-- note --></svg>', 'comment'],
    ['<svg><style><![CDATA[a{}]]></style></svg>', 'cdata'],
    ['<html><svg></svg></html>', 'not-svg-root'],
    ['<svg></svg><div></div>', 'not-svg-root'],
  ])('refuses %s', (markup, expected) => {
    expect(verdict(markup)).toBe(expected);
  });

  it.each([
    ['<svg><script>alert(1)</script></svg>', 'element:script'],
    ['<svg><SCRIPT>alert(1)</SCRIPT></svg>', 'element:script'],
    ['<svg><svg:script>alert(1)</svg:script></svg>', 'element:script'],
    ['<svg>< script>alert(1)</script></svg>', 'element:script'],
    ['<svg><foreignObject><p>x</p></foreignObject></svg>', 'element:foreignobject'],
    ['<svg><image x="0"/></svg>', 'element:image'],
    ['<svg><use x="0"/></svg>', 'element:use'],
    ['<svg><a><rect/></a></svg>', 'element:a'],
    ['<svg><animate attributeName="x"/></svg>', 'element:animate'],
    ['<svg><iframe></iframe></svg>', 'element:iframe'],
  ])('refuses the active element in %s', (markup, expected) => {
    expect(verdict(markup)).toBe(expected);
  });

  it.each([
    ['<svg><rect onload="x()"/></svg>', 'attribute:onload'],
    ['<svg><rect ONCLICK="x()"/></svg>', 'attribute:onclick'],
    ['<svg><rect href="#a"/></svg>', 'attribute:href'],
    ['<svg><rect xlink:href="#a"/></svg>', 'attribute:xlink:href'],
    ['<svg><rect externalResourcesRequired="true"/></svg>', 'attribute:externalresourcesrequired'],
  ])('refuses the active attribute in %s', (markup, expected) => {
    expect(verdict(markup)).toBe(expected);
  });

  it.each([
    ['<svg><rect fill="javascript:alert(1)"/></svg>', 'javascript-url'],
    ['<svg><rect fill="vbscript:msgbox"/></svg>', 'vbscript-url'],
    ['<svg><style>a{background:url(data:text/html,x)}</style></svg>', 'data-html-url'],
    ['<svg><style>a{background:url(data:image/svg+xml,x)}</style></svg>', 'nested-svg-url'],
    ['<svg><style>@import "x.css";</style></svg>', 'css-import'],
    ['<svg><rect style="width:expression(alert(1))"/></svg>', 'css-expression'],
    ['<svg><rect style="-moz-binding:xbl"/></svg>', 'css-binding'],
    ['<svg><rect fill="url(https://evil.example/p.svg#g)"/></svg>', 'css-url'],
    ['<svg><rect fill="url(paint.svg#g)"/></svg>', 'css-url'],
    ['<svg><desc>see https://evil.example</desc></svg>', 'remote-url'],
    ['<svg><style>a{background:url(//evil.example/p.png)}</style></svg>', 'css-url'],
    ['<svg><desc>&xxe;</desc></svg>', 'entity-reference'],
  ])('refuses the external or executable reference in %s', (markup, expected) => {
    expect(verdict(markup)).toBe(expected);
  });

  it('accepts the namespace URLs a serialized drawing must carry', () => {
    expect(
      verdict('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>')
    ).toBe('ok');
  });

  it('accepts the character references a serializer emits for label text', () => {
    expect(verdict('<svg><desc>A &amp; B &lt;C&gt; &#8212; &#x2014;</desc></svg>')).toBe('ok');
  });

  it('refuses rather than repairs: no verdict ever returns modified markup', () => {
    const result = assertInertSvg('<svg><script>alert(1)</script></svg>', OPTIONS);
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).toEqual(['ok', 'violation']);
  });
});
