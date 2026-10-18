import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import {
  MAX_WEB_ARTICLE_BLOCKS,
  MAX_WEB_ARTICLE_IMAGES,
} from '@shared/constants/web-article';
import type { DocumentMetadata, WebArticleImportOutcome } from '@shared/types/document';
import { createInterleafApi, type PreloadIpc, type PreloadWebUtils } from '../../src/preload/index';
import type { PortableValue } from '@shared/models/portable';

/**
 * What an incomplete capture is allowed to tell the renderer.
 *
 * A snapshot that could not keep every picture has to say so, and the only way
 * that fact reaches the UI is as two numbers on the import result. These tests
 * run the real bridge with a stub channel, so what is asserted is what the
 * renderer would actually receive: counts and nothing that describes where
 * Interleaf went or why a request failed.
 */

const WEB_DOC = {
  id: 'doc-web-summary',
  title: 'A beginner’s guide to split keyboards',
  author: 'Sam Rivers',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 40_960,
  fileMtimeMs: 1_757_000_000_000,
  fileHash: 'summaryhash',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  source: {
    kind: 'web',
    url: 'https://www.example-blog.com/posts/2026/02/split-keyboards/',
    siteName: 'Example Blog',
    capturedAt: '2026-09-07T10:00:00.000Z',
  },
  createdAt: '2026-09-07T10:00:00.000Z',
  updatedAt: '2026-09-07T10:00:00.000Z',
} satisfies DocumentMetadata;

const noWebUtils: PreloadWebUtils = {
  getPathForFile: () => {
    throw new Error('not used');
  },
};

/** A bridge whose import channel returns exactly the given main-side result. */
function bridgeReturning(data: PortableValue): {
  importWebArticle: () => Promise<WebArticleImportOutcome>;
  channels: string[];
} {
  const channels: string[] = [];
  const ipc: PreloadIpc = {
    invoke: (channel) => {
      channels.push(channel);
      return Promise.resolve({ ok: true, data });
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  };
  const api = createInterleafApi(ipc, noWebUtils);
  return {
    channels,
    importWebArticle: () => api.library.importWebArticle('https://example.com/a'),
  };
}

describe('web article import summary at the preload boundary', () => {
  it('passes a partial capture through as two counts', async () => {
    const bridge = bridgeReturning({
      document: WEB_DOC,
      alreadyInLibrary: false,
      media: { archived: 29, omitted: 7 },
    });
    const result = await bridge.importWebArticle();

    expect(bridge.channels).toEqual([IPC.libraryImportWebArticle]);
    expect(result.media).toEqual({ archived: 29, omitted: 7 });
    expect(result.alreadyInLibrary).toBe(false);
  });

  it('leaves a complete capture without a summary to report', async () => {
    const bridge = bridgeReturning({
      document: WEB_DOC,
      alreadyInLibrary: false,
      media: { archived: 12, omitted: 0 },
    });
    const result = await bridge.importWebArticle();
    expect(result.media).toEqual({ archived: 12, omitted: 0 });
  });

  it('drops a summary carrying anything but counts as unknown, and keeps the import', async () => {
    const hostile = [
      { archived: 1, omitted: 1, url: 'https://cdn.example.com/failed.png' },
      { archived: 1, omitted: 1, reason: 'address-policy' },
      { archived: 1, omitted: 'several' },
      { archived: -1, omitted: 1 },
      { archived: 1.5, omitted: 1 },
      // Past the real ceilings: a snapshot cannot hold more images than the
      // archive bound, nor report a larger shortfall than the counted one.
      { archived: MAX_WEB_ARTICLE_IMAGES + 1, omitted: 0 },
      { archived: 1, omitted: MAX_WEB_ARTICLE_BLOCKS + 1 },
      'seven images failed from 10.0.0.1',
      null,
    ];
    for (const media of hostile) {
      const bridge = bridgeReturning({ document: WEB_DOC, alreadyInLibrary: false, media });
      const result = await bridge.importWebArticle();
      // Unknown, not zero: a rejected summary is never shown as a real count.
      expect(result.media, JSON.stringify(media)).toBeNull();
      // The document is what the user asked for; a rejected note never costs it.
      expect(result.document.id).toBe(WEB_DOC.id);
      expect(JSON.stringify(result)).not.toContain('cdn.example.com');
      expect(JSON.stringify(result)).not.toContain('address-policy');
    }
  });
});
