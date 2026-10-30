// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentMetadata, WebArticleImportOutcome } from '@shared/types/document';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * What the reader is told about an incomplete capture.
 *
 * The import dialog closes on success either way — a snapshot missing a few
 * pictures is still a finished snapshot, with the text complete and every
 * missing figure's caption in place — so the note rides on the existing success
 * message rather than becoming an error or a blocking state. These assertions
 * are about the sentence, and about everything it must not contain.
 */

const WEB_DOC = {
  id: 'doc-web-message',
  title: 'A beginner’s guide to split keyboards',
  author: 'Sam Rivers',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 40_960,
  fileMtimeMs: 1_757_000_000_000,
  fileHash: 'messagehash',
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

/**
 * Only the calls the import path makes. The store reloads the library and the
 * summary afterwards, so both answer with something harmless.
 */
function installBridge(result: WebArticleImportOutcome): void {
  const library = {
    importWebArticle: () => Promise.resolve(result),
    listDocuments: () => Promise.resolve([WEB_DOC]),
    getRecentlyAdded: () => Promise.resolve([WEB_DOC]),
    getRecentlyRead: () => Promise.resolve([WEB_DOC]),
    getContinueReading: () => Promise.resolve([WEB_DOC]),
    getSummary: () =>
      Promise.resolve({
        totalDocuments: 1,
        formatCounts: { pdf: 0, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 1 },
        managedCount: 1,
        linkCount: 0,
        missingCount: 0,
        changedCount: 0,
        totalFolders: 0,
      }),
  };
  stubBridge({ library });
}

async function messageFor(media: WebArticleImportOutcome['media']): Promise<string> {
  installBridge({
    document: WEB_DOC,
    alreadyInLibrary: false,
    media,
  });
  await useLibraryStore.getState().importWebArticle('https://www.example-blog.com/posts/x');
  return useLibraryStore.getState().successMessage ?? '';
}

afterEach(() => {
  useLibraryStore.setState({ successMessage: null, errorMessage: null });
});

describe('web article import message', () => {
  it('says how many pictures a partial capture could not keep', async () => {
    const message = await messageFor({ archived: 29, omitted: 7 });
    expect(message).toContain('Imported "A beginner’s guide to split keyboards".');
    expect(message).toContain("7 images couldn't be saved");
    expect(message).toContain('captions were kept');
    expect(useLibraryStore.getState().errorMessage).toBeNull();
    expect(useLibraryStore.getState().libraryModal).toBeNull();
  });

  it('reads naturally when exactly one picture is missing', async () => {
    const message = await messageFor({ archived: 3, omitted: 1 });
    expect(message).toContain("One image couldn't be saved; its caption was kept.");
  });

  it('leaves a complete capture with the plain success message', async () => {
    expect(await messageFor({ archived: 36, omitted: 0 })).toBe(
      'Imported "A beginner’s guide to split keyboards".'
    );
  });

  it('says the count is unknown when the bridge could not verify it', async () => {
    const message = await messageFor(null);
    expect(message).toBe(
      'Imported "A beginner’s guide to split keyboards". ' +
        "Interleaf couldn't confirm how many images were saved."
    );
    expect(message).not.toContain('0 images');
  });

  it('keeps the already-in-library wording and still reports the shortfall', async () => {
    installBridge({
      document: WEB_DOC,
      alreadyInLibrary: true,
      media: { archived: 1, omitted: 2 },
    });
    await useLibraryStore.getState().importWebArticle('https://www.example-blog.com/posts/x');
    const message = useLibraryStore.getState().successMessage ?? '';
    expect(message).toContain('is already in your library.');
    expect(message).toContain("2 images couldn't be saved");
  });

  it('never names a host, an address, a path, or a reason', async () => {
    const message = await messageFor({ archived: 29, omitted: 7 });
    for (const forbidden of [
      'http',
      'example-blog.com',
      '.png',
      '/',
      'timeout',
      'decode',
      'blocked',
      'security',
    ]) {
      expect(message.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
