import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeDocxFixture, makePdfFixture } from '../fixtures/document-fixtures';

/**
 * An installed Interleaf is launched with an unrelated working directory
 * (Finder and `open` start it from `/`). The preview worker's fflate, pdfjs and
 * @napi-rs/canvas paths were resolved from `process.cwd()`, so the packaged
 * 0.2.0 app failed at startup with `Cannot find module 'fflate'` from the
 * require stack `//package.json`. Loading the module and running all three
 * worker dependency paths while cwd is `/` pins that the resolution follows
 * the main module rather than the launch directory.
 */

type PreviewWorkerModule = typeof import('../../src/main/workers/preview-extract-worker');

async function loadWithWorkingDirectory(cwd: string): Promise<PreviewWorkerModule> {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    return await import('../../src/main/workers/preview-extract-worker');
  } finally {
    vi.restoreAllMocks();
  }
}

describe('preview-extract-worker dependency resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('loads and runs fflate, pdfjs and canvas worker paths when launched from /', async () => {
    const { extractPreviewInWorker } = await loadWithWorkingDirectory('/');

    const docx = await extractPreviewInWorker({
      format: 'docx',
      buffer: makeDocxFixture({ title: 'Neutral cwd', author: 'Tester', bodyText: 'Unzipped by fflate.' }),
      targetParagraphIndex: 0,
    });
    expect(docx.snippet).toContain('DOCX Foundations');

    const pdf = await extractPreviewInWorker({
      format: 'pdf',
      buffer: makePdfFixture({ title: 'Neutral cwd', author: 'Tester', pageLines: [['Rendered by pdfjs and canvas.']] }),
      renderCover: true,
    });
    expect(pdf.coverPng?.subarray(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
