// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  SvgSanitizeError,
  sanitizeRenderedSvg,
} from '../../src/renderer/mermaid-sandbox/svg-allowlist';

const MAX_DIMENSION = 8_000;

function sanitize(markup: string): string {
  return sanitizeRenderedSvg(markup, MAX_DIMENSION).markup;
}

function svg(body: string, viewBox = '0 0 100 50'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
}

describe('sandbox SVG allow-list', () => {
  it('keeps the shapes and text a diagram is made of', () => {
    const result = sanitizeRenderedSvg(
      svg(
        '<g transform="translate(4,4)"><rect x="0" y="0" width="10" height="10" fill="#eee"/><text x="2" y="8" font-size="12">Start</text></g>'
      ),
      MAX_DIMENSION
    );
    expect(result.markup).toContain('<rect');
    expect(result.markup).toContain('Start');
    expect(result.markup).toContain('transform="translate(4,4)"');
  });

  it('reports the intrinsic size from the viewBox and pins it on the root', () => {
    const result = sanitizeRenderedSvg(svg('<rect/>', '0 0 123.4 56.7'), MAX_DIMENSION);
    expect(result.width).toBe(124);
    expect(result.height).toBe(57);
    expect(result.markup).toContain('width="124"');
    expect(result.markup).toContain('height="57"');
  });

  it('drops the library max-width style that would override the reader layout', () => {
    const markup = sanitize(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" style="max-width:100px"><rect/></svg>'
    );
    expect(markup).not.toContain('max-width');
  });

  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<foreignObject><p>x</p></foreignObject>', 'foreignObject'],
    ['<image href="https://evil.example/p.png"/>', 'image'],
    ['<use href="#g"/>', 'use'],
    ['<animate attributeName="x"/>', 'animate'],
    ['<iframe src="https://evil.example"></iframe>', 'iframe'],
  ])('leaves %s behind rather than copying it', (body, token) => {
    expect(sanitize(svg(body))).not.toContain(token);
  });

  it('unwraps a link so a hostile click costs the link and not the picture', () => {
    const markup = sanitize(
      svg('<a href="https://evil.example"><rect width="10" height="10"/><text>Node</text></a>')
    );
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toMatch(/<a[\s>]/);
    // The shape and its label are still drawn.
    expect(markup).toContain('<rect');
    expect(markup).toContain('Node');
  });

  it.each([
    '<rect onload="steal()" width="10" height="10"/>',
    '<rect onclick="steal()" width="10" height="10"/>',
  ])('drops the event attribute in %s', (body) => {
    const markup = sanitize(svg(body));
    expect(markup).not.toMatch(/on[a-z]+=/i);
    expect(markup).toContain('<rect');
  });

  it('drops a namespaced reference such as xlink:href', () => {
    const markup = sanitize(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50"><rect xlink:href="#g" width="10" height="10"/></svg>'
    );
    expect(markup).not.toContain('href');
    expect(markup).toContain('<rect');
  });

  it.each([
    '<rect fill="javascript:alert(1)" width="10" height="10"/>',
    '<rect fill="url(https://evil.example/p.svg#g)" width="10" height="10"/>',
    '<rect style="background:url(//evil.example/p.png)" width="10" height="10"/>',
  ])('drops the external or executable value in %s', (body) => {
    const markup = sanitize(svg(body));
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toContain('javascript:');
  });

  it('keeps a same-document marker reference, which is how arrowheads work', () => {
    const markup = sanitize(
      svg(
        '<defs><marker id="head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6"/></marker></defs><path d="M0,0 L50,0" marker-end="url(#head)"/>'
      )
    );
    expect(markup).toContain('marker-end="url(#head)"');
    expect(markup).toContain('<marker');
  });

  it('keeps the theme stylesheet but refuses one that reaches outside the drawing', () => {
    expect(sanitize(svg('<style>.node rect{fill:#eee;}</style><rect/>'))).toContain('fill:#eee');
    expect(() => sanitize(svg('<style>@import url(https://evil.example/x.css);</style>'))).toThrow(
      SvgSanitizeError
    );
    expect(() =>
      sanitize(svg('<style>.n{background:url(https://evil.example/p.png)}</style>'))
    ).toThrow(SvgSanitizeError);
  });

  it.each([
    ['markup that is not parseable', '<svg xmlns="http://www.w3.org/2000/svg"><rect>'],
    ['a root that is not an svg', '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'],
    ['a drawing with no viewBox', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
  ])('refuses %s', (_name, markup) => {
    expect(() => sanitize(markup)).toThrow(SvgSanitizeError);
  });

  it('refuses a drawing larger than the fixed dimension bound', () => {
    expect(() => sanitize(svg('<rect/>', `0 0 ${String(MAX_DIMENSION + 1)} 10`))).toThrow(
      /dimensions/
    );
  });

  it('refuses a drawing nested past the depth bound', () => {
    const deep = `${'<g>'.repeat(80)}<rect/>${'</g>'.repeat(80)}`;
    expect(() => sanitize(svg(deep))).toThrow(/depth/);
  });
});
