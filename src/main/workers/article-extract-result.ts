import { InterleafError } from '@shared/errors/interleaf-error';
import type { PortableValue } from '@shared/models/portable';
import { extractedArticleSchema, type ExtractedArticle } from '../library/article-content';

/** Below this much readable text a page is treated as having no article. */
export const MIN_ARTICLE_TEXT_LENGTH = 250;

/** Validates one worker reply into the article IR, or throws the typed failure it describes. */
export function messageToArticle(message: PortableValue): ExtractedArticle {
  if (typeof message !== 'object' || message === null || !('ok' in message)) {
    throw new InterleafError('internal', 'Article extraction returned an unusable result.');
  }
  if (message.ok !== true) {
    const reason = 'reason' in message && typeof message.reason === 'string' ? message.reason : 'failed';
    if (reason === 'too-large') {
      throw new InterleafError(
        'validation',
        'That page is too large or too complex for Interleaf to import.'
      );
    }
    if (reason === 'too-complex') {
      throw new InterleafError(
        'validation',
        'That page is too complex for Interleaf to import safely.'
      );
    }
    throw new InterleafError(
      'validation',
      'Interleaf could not find an article to read on that page.'
    );
  }
  const parsed = extractedArticleSchema.safeParse(
    'article' in message ? message.article : undefined
  );
  if (!parsed.success) {
    throw new InterleafError('internal', 'Article extraction returned an unusable result.');
  }
  if (parsed.data.textLength < MIN_ARTICLE_TEXT_LENGTH) {
    throw new InterleafError(
      'validation',
      'Interleaf could not find an article to read on that page.'
    );
  }
  return parsed.data;
}
