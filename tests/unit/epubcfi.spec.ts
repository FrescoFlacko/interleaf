// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as CFI from '../../src/renderer/features/reader/adapters/foliate/epubcfi';

function xhtml(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'application/xhtml+xml');
}

describe('EPUB CFI', () => {
  it('round-trips fake spine CFIs and orders indirect locations', () => {
    for (let index = 0; index < 8; index++) {
      const cfi = CFI.fake.fromIndex(index);
      const parsed = CFI.parse(cfi);
      expect(CFI.fake.toIndex(parsed as CFI.ParsedCFIIndir)).toBe(index);
      expect(CFI.toString(parsed)).toBe(cfi);
    }

    const comparisons: [string, string, number][] = [
      ['/6/4!/10', '/6/4!/10', 0],
      ['/6/4!/2/3:0', '/6/4!/2', 1],
      ['/6/4!/2/4/6/8/10/3:0', '/6/4!/4', -1],
      ['/6/4[chap0^]!/1ref^^]!/4[body01^^]/10[para^]^,05^^]', '/6/4!/4/10', 0],
      ['/6/4[chap0^]!/1ref^^]!/4[body01^^],/10[para^]^,05^^],/15:10[foo^]]]', '/6/4!/4/12', -1],
      ['/6/4', '/6/4!/2', -1],
      ['/6/4!/2', '/6/4!/2!/2', -1],
    ];
    for (const [left, right, expected] of comparisons) {
      expect(CFI.compare(left, right)).toBe(expected);
    }
  });

  it('resolves package elements through both upstream local paths and full parsed CFIs', () => {
    const document = xhtml(`<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest/>
      <spine><itemref id="title"/><itemref id="chap0]!/1ref^"/></spine></package>`);
    const cfi = '/6/4[chap0^]!/1ref^^]';
    const parsed = CFI.parse(cfi) as CFI.ParsedCFIIndir;
    const expected = document.getElementById('chap0]!/1ref^');
    expect(CFI.toElement(document, parsed[0]!)).toBe(expected);
    expect(CFI.toElement(document, parsed)).toBe(expected);
    expect(CFI.fake.toIndex(CFI.parse('/6/8') as CFI.ParsedCFIIndir)).toBe(3);
    expect(CFI.fake.toIndex((CFI.parse('/6/8') as CFI.ParsedCFIIndir)[0])).toBe(3);
  });

  it('resolves the content path of a fully indirect CFI', () => {
    const document = xhtml(`<html xmlns="http://www.w3.org/1999/xhtml"><head/><body>
      <p>zero</p><p id="target">abcdef</p>
    </body></html>`);
    const cfi = 'epubcfi(/6/4!/4/4[target]/1:3)';
    const parsed = CFI.parse(cfi) as CFI.ParsedCFIIndir;
    expect(CFI.fake.toIndex(parsed[0])).toBe(1);
    const range = CFI.toRange(document, parsed);
    expect(range.startContainer.nodeValue).toBe('abcdef');
    expect(range.startOffset).toBe(3);
  });

  it('resolves and serializes collapsed and ranged text locations', () => {
    const document = xhtml(`<html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>Fixture</title></head>
      <body id="body01">
        <p>one</p><p>two</p><p>three</p><p>four</p>
        <p id="para05">xxx<em>yyy</em>0123456789</p>
      </body>
    </html>`);

    const point = '/4[body01]/10[para05]/3:10';
    const pointRange = CFI.toRange(document, CFI.parse(point));
    expect(CFI.fromRange(pointRange)).toBe(`epubcfi(${point})`);

    const selection = CFI.toRange(document, CFI.parse('/4/10,/3:2,/3:6'));
    expect(selection.toString()).toBe('2345');
    const recreated = CFI.fromRange(selection);
    expect(CFI.compare(CFI.collapse(recreated), '/4/10/3:2')).toBe(0);
    expect(CFI.compare(CFI.collapse(recreated, true), '/4/10/3:6')).toBe(0);
  });

  it('preserves offsets through FILTER_SKIP wrappers', () => {
    const document = xhtml(`<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>
      <p id="plain">Hello, World</p>
      <p id="wrapped"><span class="skip">H</span>e<span class="skip">ll</span>o, World</p>
    </body></html>`);
    const filter = (node: Node): number =>
      node.nodeType === Node.ELEMENT_NODE && (node as Element).classList.contains('skip')
        ? NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT;
    const wrapped = document.getElementById('wrapped');
    const skipNodes = wrapped?.querySelectorAll('.skip');
    const start = skipNodes?.[1]?.firstChild;
    const end = wrapped?.lastChild;
    expect(start).toBeTruthy();
    expect(end).toBeTruthy();

    const range = document.createRange();
    range.setStart(start!, 1);
    range.setEnd(end!, 4);
    const cfi = CFI.fromRange(range, filter);
    expect(cfi).toBe('epubcfi(/4/4[wrapped],/1:3,/1:8)');
    expect(CFI.toRange(document, CFI.parse(cfi), filter).toString()).toBe('lo, W');
  });

  it('escapes assertion characters and rejects malformed ranges', () => {
    const parsed: CFI.ParsedCFIIndir = [[{ index: 4, id: 'chap],^', offset: 3 }]];
    const serialized = CFI.toString(parsed);
    expect(CFI.toString(CFI.parse(serialized))).toBe(serialized);
    expect(() => CFI.parse('/4,/2')).toThrow('Invalid EPUB CFI range');
  });
});
