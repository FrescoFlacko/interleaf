import { describe, expect, it } from 'vitest';
import { isPortableRecord, parsePortableJson } from '@shared/models/portable';

/**
 * `PortableValue` is the declared type of data that crossed a provider, file or
 * SQLite boundary but has not been validated yet. Its whole claim is that the
 * value round-trips: what a reader hands on is what a writer can store again.
 * `JSON.parse` alone breaks that claim at the numeric edges, and the shared
 * parser is the single place that can close it for every caller, since provider
 * readers, the credential vault and JSON columns all go through it rather than
 * through the Zod schema.
 */

describe('parsePortableJson', () => {
  it('rejects an exponent that overflows to Infinity', () => {
    // Valid JSON text, and `JSON.parse` answers Infinity, which
    // `JSON.stringify` then writes back as `null`.
    expect(JSON.parse('1e400')).toBe(Infinity);
    expect(() => parsePortableJson('1e400')).toThrow(SyntaxError);
  });

  it.each([
    ['a negative exponent overflow', '-1e400'],
    ['a non-finite number nested in a record', '{"usage":{"cost":1e400}}'],
    ['a non-finite number nested in an array', '{"samples":[1,2,1e400]}'],
    ['malformed text, the same way', '{"unterminated":'],
  ])('rejects %s', (_label, text) => {
    expect(() => parsePortableJson(text)).toThrow(SyntaxError);
  });

  it('accepts values at the representable edges', () => {
    expect(parsePortableJson('1e308')).toBe(1e308);
    expect(parsePortableJson('5e-324')).toBe(5e-324);
    expect(parsePortableJson('0')).toBe(0);
    expect(parsePortableJson('-0')).toBe(-0);
  });

  it('returns ordinary portable data unchanged', () => {
    const parsed = parsePortableJson('{"id":"a","count":2,"ok":true,"none":null,"list":[1,"two"]}');
    expect(parsed).toEqual({ id: 'a', count: 2, ok: true, none: null, list: [1, 'two'] });
    expect(isPortableRecord(parsed)).toBe(true);
  });

  it('returns only values that survive being written back out', () => {
    const text = '{"nested":{"deep":[{"value":3.5}]}}';
    expect(JSON.stringify(parsePortableJson(text))).toBe(text);
  });
});
