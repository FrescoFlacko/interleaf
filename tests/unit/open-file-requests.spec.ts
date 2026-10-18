import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { OpenFileRequestQueue, isOpenablePath, openablePathsFromArgv } from '../../src/main/open-files/open-file-requests';

describe('operating-system open requests', () => {
  it('accepts every supported extension regardless of case', () => {
    for (const name of ['a.pdf', 'b.EPUB', 'c.Mobi', 'd.azw', 'e.AZW3', 'f.docx', 'g.PPTX', 'h.md', 'i.Markdown']) {
      expect(isOpenablePath(`/docs/${name}`), name).toBe(true);
    }
  });

  it('rejects unsupported, extensionless, oversized and NUL-bearing paths', () => {
    for (const candidate of ['', '/docs/movie.mp4', '/docs/README', '/docs/archive.pdf.zip', `/docs/${'x'.repeat(5000)}.pdf`, '/docs/a\0.pdf']) {
      expect(isOpenablePath(candidate), candidate.slice(0, 40)).toBe(false);
    }
  });

  it('takes document paths from a launch command line and ignores the executable and switches', () => {
    const argv = ['/Applications/Interleaf', '--inspect=9229', '-psn_0_1234', 'notes/Chapter.MD', '/abs/paper.pdf', 'setup.exe', '--', 'deck.pptx'];
    expect(openablePathsFromArgv(argv, '/home/reader')).toEqual([
      resolve('/home/reader', 'notes/Chapter.MD'),
      '/abs/paper.pdf',
      resolve('/home/reader', 'deck.pptx'),
    ]);
    expect(openablePathsFromArgv(['/Applications/Interleaf'], '/')).toEqual([]);
    expect(openablePathsFromArgv(['/Applications/Interleaf.pdf'], '/')).toEqual([]);
  });

  it('holds a request that arrives before the window until it is claimed once', () => {
    const queue = new OpenFileRequestQueue();
    expect(queue.enqueue(['/docs/early.pdf'])).toBe(true);
    const notify = vi.fn();
    queue.attach(notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(queue.take()).toBe('/docs/early.pdf');
    expect(queue.take()).toBeNull();
  });

  it('keeps only the latest openable path and nudges an attached window for each', () => {
    const queue = new OpenFileRequestQueue();
    const notify = vi.fn();
    queue.attach(notify);
    expect(notify).not.toHaveBeenCalled();
    expect(queue.enqueue(['/docs/unsupported.txt'])).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(queue.enqueue(['/docs/one.epub', '/docs/two.docx', '/docs/skip.exe'])).toBe(true);
    expect(queue.enqueue(['/docs/three.md'])).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(queue.take()).toBe('/docs/three.md');
  });
});
