import { z } from 'zod';
import { InterleafError } from '@shared/errors/interleaf-error';

const fragmentSchema = z.object({ version: z.literal(1), documentHash: z.string().min(1).max(256),
  chunkId: z.string().min(1).max(128), query: z.string().trim().min(1).max(200).optional() }).strict();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export type PassageReference = { readonly documentId: string; readonly documentHash: string; readonly chunkId: string; readonly query?: string };

export function makePassageLink(reference: PassageReference): string {
  const documentId = idSchema.parse(reference.documentId);
  const fragment = fragmentSchema.parse({ version: 1, documentHash: reference.documentHash, chunkId: reference.chunkId, ...(reference.query === undefined ? {} : { query: reference.query }) });
  const bytes = Buffer.from(JSON.stringify(fragment), 'utf8');
  if (bytes.length > 1024) throw new InterleafError('validation', 'Passage link is too long.');
  const link = `interleaf://doc/${documentId}#${bytes.toString('base64url')}`;
  if (link.length > 2048) throw new InterleafError('validation', 'Passage link is too long.');
  return link;
}

export function parsePassageLink(value: string): PassageReference {
  try {
    if (value.length > 2_048 || !/^interleaf:\/\/doc\/[A-Za-z0-9_-]{1,128}#[A-Za-z0-9_-]+$/u.test(value)) throw new Error('shape');
    const parsed = new URL(value);
    const documentId = idSchema.parse(parsed.pathname.slice(1));
    const encoded = parsed.hash.slice(1);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded || bytes.length > 1024) throw new Error('encoding');
    const fragment = fragmentSchema.parse(JSON.parse(bytes.toString('utf8')));
    return { documentId, documentHash: fragment.documentHash, chunkId: fragment.chunkId, ...(fragment.query === undefined ? {} : { query: fragment.query }) };
  } catch {
    throw new InterleafError('validation', 'Invalid Interleaf passage link.');
  }
}
