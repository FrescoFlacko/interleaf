// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { ImportMenu } from '../../src/renderer/features/library/components/ImportMenu';
import { ImportWebArticleModal } from '../../src/renderer/features/library/components/ImportWebArticleModal';
import { ImportDropzone } from '../../src/renderer/features/library/components/ImportDropzone';
import { DocumentCard } from '../../src/renderer/features/library/components/DocumentCard';
import { DocumentListItem } from '../../src/renderer/features/library/components/DocumentListItem';
import type { DocumentMetadata, WebArticleImportOutcome } from '@shared/types/document';

/**
 * Renderer behaviour for the web-import surface.
 *
 * The dialog is the only place a user can start a network fetch, so the tests
 * cover the things that make it safe and usable rather than its appearance:
 * keyboard reachability, focus return, one submission per press, and a typed
 * error rendered as text next to the field that caused it.
 */

const WEB_DOC: DocumentMetadata = {
  id: 'doc-web-1',
  title: 'Why margins matter',
  author: 'A Reporter',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 4096,
  fileMtimeMs: Date.now(),
  fileHash: 'webhash789',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  source: {
    kind: 'web',
    url: 'https://example.com/posts/the-margin',
    siteName: 'Example Times',
    capturedAt: new Date('2026-09-01T10:00:00Z').toISOString(),
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const FILE_DOC: DocumentMetadata = { ...WEB_DOC, id: 'doc-file-1', format: 'pdf', source: null };

function resolvedImport(): Promise<WebArticleImportOutcome> {
  return Promise.resolve({ document: WEB_DOC, alreadyInLibrary: false, media: { archived: 0, omitted: 0 } });
}

/** Renders the dialog behind a trigger so focus return has somewhere to go. */
function DialogHarness({
  onSubmit,
}: {
  readonly onSubmit: (url: string) => Promise<WebArticleImportOutcome>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="harness-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <ImportWebArticleModal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onSubmit={onSubmit}
        folderId={null}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe('import source menu', () => {
  test('keeps the primary button importing files in one press', () => {
    const onFiles = vi.fn();
    const onWeb = vi.fn();
    render(<ImportMenu isImporting={false} onImportFromFiles={onFiles} onImportFromWeb={onWeb} />);

    fireEvent.click(screen.getByTestId('import-files-button'));
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('library-import-menu')).toBeNull();
  });

  test('names both import sources in an accessible menu', async () => {
    const onFiles = vi.fn();
    const onWeb = vi.fn();
    render(<ImportMenu isImporting={false} onImportFromFiles={onFiles} onImportFromWeb={onWeb} />);

    const trigger = screen.getByTestId('import-options-button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    const menu = await screen.findByTestId('library-import-menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('import-from-files-item').textContent).toContain('From files…');
    expect(screen.getByTestId('import-from-web-item').textContent).toContain('From web URL…');

    const results = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('moves between items with the arrow keys and closes on Escape', async () => {
    render(<ImportMenu isImporting={false} onImportFromFiles={vi.fn()} onImportFromWeb={vi.fn()} />);

    const trigger = screen.getByTestId('import-options-button');
    fireEvent.click(trigger);
    const menu = await screen.findByTestId('library-import-menu');

    await waitFor(() => {
      expect(screen.getByTestId('import-from-files-item')).toHaveFocus();
    });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByTestId('import-from-web-item')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByTestId('import-from-files-item')).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('library-import-menu')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  test('Tab closes menu without preventing default so forward navigation proceeds', async () => {
    render(<ImportMenu isImporting={false} onImportFromFiles={vi.fn()} onImportFromWeb={vi.fn()} />);
    const trigger = screen.getByTestId('import-options-button');
    fireEvent.click(trigger);
    const menu = await screen.findByTestId('library-import-menu');

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    menu.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => {
      expect(screen.queryByTestId('library-import-menu')).toBeNull();
    });
  });

  test('choosing the web item asks for a URL instead of opening a file picker', async () => {
    const onFiles = vi.fn();
    const onWeb = vi.fn();
    render(<ImportMenu isImporting={false} onImportFromFiles={onFiles} onImportFromWeb={onWeb} />);

    fireEvent.click(screen.getByTestId('import-options-button'));
    fireEvent.click(await screen.findByTestId('import-from-web-item'));

    expect(onWeb).toHaveBeenCalledTimes(1);
    expect(onFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId('library-import-menu')).toBeNull();
    });
  });

  test('disables both halves while an import is running', () => {
    render(<ImportMenu isImporting onImportFromFiles={vi.fn()} onImportFromWeb={vi.fn()} />);
    expect(screen.getByTestId('import-files-button')).toBeDisabled();
    expect(screen.getByTestId('import-options-button')).toBeDisabled();
  });
});

describe('first-run import surface', () => {
  test('offers the web option as a secondary route without a second primary action', () => {
    const onWeb = vi.fn();
    render(
      <ImportDropzone
        isImporting={false}
        onImportDroppedFiles={vi.fn()}
        onOpenFileDialog={vi.fn()}
        onImportFromWeb={onWeb}
      />
    );

    const primary = screen.getByTestId('select-files-button');
    const secondary = screen.getByTestId('dropzone-import-web-button');
    expect(secondary.textContent).toContain('web URL');
    // The emphasised call to action stays singular: the web route is a link-like
    // control, not a second filled button competing with it.
    expect(primary.className).toContain('bg-accent');
    expect(secondary.className).not.toContain('bg-accent');

    fireEvent.click(secondary);
    expect(onWeb).toHaveBeenCalledTimes(1);
  });
});

describe('web article dialog', () => {
  test('is a labelled modal dialog that takes focus and passes an axe audit', async () => {
    render(<DialogHarness onSubmit={resolvedImport} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));

    const dialog = await screen.findByTestId('import-web-article-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Import from web URL'
    );

    await waitFor(() => {
      expect(screen.getByTestId('web-article-url-input')).toHaveFocus();
    });

    const results = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('rejects a malformed address before spending a round trip', async () => {
    const onSubmit = vi.fn(resolvedImport);
    render(<DialogHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');

    const input = screen.getByTestId('web-article-url-input');
    for (const [value, expected] of [
      ['', 'Enter a web address.'],
      ['   ', 'Enter a web address.'],
      ['example.com/article', 'Enter a full http:// or https:// address.'],
      ['ftp://example.com/a', 'Enter a full http:// or https:// address.'],
      [`https://example.com/${'a'.repeat(2100)}`, 'That web address is too long.'],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByTestId('submit-web-article-button'));
      const error = await screen.findByTestId('web-article-url-error');
      expect(error.textContent).toBe(expected);
      expect(error.getAttribute('role')).toBe('alert');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('web-article-url-error');
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('clears the error as soon as the user edits the field', async () => {
    render(<DialogHarness onSubmit={resolvedImport} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');

    const input = screen.getByTestId('web-article-url-input');
    fireEvent.change(input, { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByTestId('submit-web-article-button'));
    await screen.findByTestId('web-article-url-error');

    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    expect(screen.queryByTestId('web-article-url-error')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('web-article-url-hint');
  });

  test('shows progress and refuses a second submission while one is in flight', async () => {
    let release: ((result: WebArticleImportOutcome) => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<WebArticleImportOutcome>((resolve) => {
          release = resolve;
        })
    );
    render(<DialogHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');

    fireEvent.change(screen.getByTestId('web-article-url-input'), {
      target: { value: 'https://example.com/article' },
    });
    const submit = screen.getByTestId('submit-web-article-button');
    fireEvent.click(submit);

    const progress = await screen.findByTestId('web-article-progress');
    expect(progress.getAttribute('role')).toBe('status');
    expect(progress.getAttribute('aria-live')).toBe('polite');
    expect(submit).toBeDisabled();

    // Repeated presses and a second Enter must not start a second fetch.
    fireEvent.click(submit);
    const form = submit.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.({ document: WEB_DOC, alreadyInLibrary: false, media: { archived: 0, omitted: 0 } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('import-web-article-modal')).toBeNull();
    });
  });

  test('renders the typed failure from main beside the field and allows a retry', async () => {
    const onSubmit = vi
      .fn<(url: string) => Promise<WebArticleImportOutcome>>()
      .mockRejectedValueOnce(
        new Error('That site resolves to a private or reserved network address, so Interleaf did not connect.')
      )
      .mockImplementation(resolvedImport);

    render(<DialogHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');

    fireEvent.change(screen.getByTestId('web-article-url-input'), {
      target: { value: 'https://example.com/article' },
    });
    fireEvent.click(screen.getByTestId('submit-web-article-button'));

    const error = await screen.findByTestId('web-article-url-error');
    expect(error.textContent).toContain('private or reserved network address');
    // The dialog stays open with the address still on screen, so the message
    // sits next to the field the user must change.
    expect(screen.getByTestId('import-web-article-modal')).toBeTruthy();
    expect(screen.getByTestId('web-article-url-input')).toHaveValue(
      'https://example.com/article'
    );
    expect(screen.getByTestId('submit-web-article-button')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('submit-web-article-button'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
  });

  test('closes on Escape and on Cancel, returning focus to the control that opened it', async () => {
    for (const dismiss of ['escape', 'cancel'] as const) {
      render(<DialogHarness onSubmit={resolvedImport} />);
      const trigger = screen.getByTestId('harness-trigger');
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByTestId('import-web-article-modal');

      if (dismiss === 'escape') {
        fireEvent.keyDown(dialog, { key: 'Escape' });
      } else {
        fireEvent.click(screen.getByTestId('cancel-web-article-button'));
      }

      await waitFor(() => {
        expect(screen.queryByTestId('import-web-article-modal')).toBeNull();
      });
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
      cleanup();
    }
  });

  test('keeps Tab inside the dialog', async () => {
    render(<DialogHarness onSubmit={resolvedImport} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    const dialog = await screen.findByTestId('import-web-article-modal');

    screen.getByTestId('submit-web-article-button').focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    screen.getByTestId('web-article-url-input').focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('starts empty each time it is opened', async () => {
    render(<DialogHarness onSubmit={resolvedImport} />);
    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');
    fireEvent.change(screen.getByTestId('web-article-url-input'), {
      target: { value: 'https://example.com/a' },
    });
    fireEvent.click(screen.getByTestId('cancel-web-article-button'));

    fireEvent.click(screen.getByTestId('harness-trigger'));
    await screen.findByTestId('import-web-article-modal');
    expect(screen.getByTestId('web-article-url-input')).toHaveValue('');
  });

  test('adapts to 320px width and 200% zoom with wrapping buttons and no clipping', async () => {
    const container = document.createElement('div');
    container.style.width = '320px';
    container.style.fontSize = '32px';
    document.body.appendChild(container);

    render(<DialogHarness onSubmit={resolvedImport} />, { container });
    fireEvent.click(screen.getByTestId('harness-trigger'));
    const dialog = await screen.findByTestId('import-web-article-modal');

    expect(dialog).toBeVisible();
    // Full width up to a bounded maximum, inside a padded backdrop: at 320 CSS
    // pixels the dialog shrinks instead of clipping its buttons.
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).toContain('max-w-md');
    expect(dialog.parentElement?.className).toContain('p-4');
    const cancelBtn = screen.getByTestId('cancel-web-article-button');
    const submitBtn = screen.getByTestId('submit-web-article-button');
    expect(cancelBtn).toBeVisible();
    expect(submitBtn).toBeVisible();

    const buttonRow = cancelBtn.parentElement;
    expect(buttonRow?.className).toContain('flex-wrap');

    container.remove();
  });
});

describe('library presentation', () => {
  test('marks a web snapshot in the grid through the cover, not an emblem badge', () => {
    render(<DocumentCard document={WEB_DOC} onOpen={vi.fn()} onDetails={vi.fn()} />);
    // The grid card dropped the badge: provenance is the generated cover's own
    // eyebrow and plain attribution line, and no new format is invented.
    expect(screen.queryByTestId('source-badge-doc-web-1')).toBeNull();
    const generated = screen.getByTestId('generated-cover-doc-web-1');
    expect(generated.textContent).toContain('Web article');
    expect(generated.textContent).toContain('Example Times');
    expect(screen.queryByTestId('format-badge-doc-web-1')).toBeNull();
  });

  test('marks a web snapshot in the list view', () => {
    render(<DocumentListItem document={WEB_DOC} onOpen={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.getByTestId('source-badge-doc-web-1').textContent).toContain('Example Times');
  });

  test('leaves file-imported documents unmarked', () => {
    render(<DocumentCard document={FILE_DOC} onOpen={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.queryByTestId('source-badge-doc-file-1')).toBeNull();
  });

  test('truncates oversized site names visually and caps tooltip length', () => {
    const longSiteDoc = {
      ...WEB_DOC,
      source: {
        kind: 'web' as const,
        url: 'https://example.com/long',
        siteName: 'A'.repeat(120),
        capturedAt: '2026-09-01T00:00:00.000Z',
      },
    };
    render(<DocumentListItem document={longSiteDoc} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const badge = screen.getByTestId('source-badge-doc-web-1');
    // The cap stays in absolute units: a percentage cap is unresolvable while a
    // flex parent measures its max-content width, so the row would size itself
    // to the untruncated name. The painted consequence is asserted in Electron E2E.
    expect(badge.className).toContain('max-w-[140px]');
    expect(badge.style.maxWidth).toBe('');
    const title = badge.getAttribute('title');
    expect(title?.length).toBeLessThanOrEqual(120);
    expect(title).toContain('…');
  });
});
