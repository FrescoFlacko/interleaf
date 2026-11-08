import { describe, expect, it } from 'vitest';
import { makePassageLink, parsePassageLink } from '@main/agent-access/passage-link';

describe('passage links', () => {
  it('round trips bounded revision-bound references and rejects malformed targets', () => {
    const ref = { documentId: 'doc-123', documentHash: 'hash-v1', chunkId: 'chunk-1' };
    const link = makePassageLink(ref);
    expect(link).toMatch(/^interleaf:\/\/doc\/doc-123#/u);
    expect(parsePassageLink(link)).toEqual(ref);
    for (const bad of ['https://doc/doc-123#x', 'interleaf://doc/../secret#e30',
      `${link}?query`, 'interleaf://user@doc/doc-123#e30', `interleaf://doc/doc-123#${'A'.repeat(2048)}`]) {
      expect(() => parsePassageLink(bad)).toThrow();
    }
  });
});
