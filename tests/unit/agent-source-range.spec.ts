import { expect, it } from 'vitest';
import { sourceMatchesChunk } from '@main/agent-access/source-validation';
import type { AgentSource } from '@shared/schemas/agent-access';

it.each(['epub', 'mobi'] as const)('rejects a mismatched indexed %s range', (format) => {
  const native = format === 'epub' ? { format, cfi: 'epubcfi(/6/2)' } : { format, sectionIndex: 1 };
  const source: AgentSource = { documentId: 'doc', documentHash: 'hash', chunkId: 'chunk', anchor: { ...native, textStart: 104, textEnd: 110, quote: { exact: 'needle', prefix: '', suffix: '' } } };
  const location = JSON.stringify({ ...native, textStart: 100, textEnd: 115 });
  expect(sourceMatchesChunk(source, location, 'The needle text')).toBe(true);
  expect(sourceMatchesChunk({ ...source, anchor: { ...native, textStart: 105, textEnd: 111, quote: { exact: 'needle', prefix: '', suffix: '' } } }, location, 'The needle text')).toBe(false);
});
