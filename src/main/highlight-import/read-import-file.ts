import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { InterleafError } from '@shared/errors/interleaf-error';
import { decodeImport, MAX_IMPORT_BYTES, parseKindle, parseReadwise, type ParsedImport } from './parser';

export async function readImportFile(path: string): Promise<{ provider: 'kindle' | 'readwise'; parsed: ParsedImport }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Uint8Array;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new InterleafError('validation', 'Choose a regular file no larger than 5 MB.');
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_IMPORT_BYTES) throw new InterleafError('validation', 'The import file exceeds the 5 MB limit.');
    bytes = buffer.subarray(0, size);
  } finally { await file.close(); }
  const provider = path.toLowerCase().endsWith('.csv') ? 'readwise' : 'kindle';
  try {
    const text = decodeImport(bytes);
    return { provider, parsed: provider === 'readwise' ? parseReadwise(text) : parseKindle(text) };
  } catch (error) {
    throw new InterleafError('validation', error instanceof Error ? error.message : 'Invalid import file.');
  }
}
