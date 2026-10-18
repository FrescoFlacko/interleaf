import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { webArticleUrlProblem } from '@shared/constants/web-article';
import type { DocumentImportOptions, WebArticleImportOutcome } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';
import { phaseAttributes, useModalPresence } from '../../../components/ui/popover-presence';
import { useDialogFocus } from './library-dialog-focus';

type ImportWebArticleModalProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (
    url: string,
    options?: DocumentImportOptions
  ) => Promise<WebArticleImportOutcome>;
  /** Folder the library is currently showing, so the snapshot lands in view. */
  readonly folderId: string | null;
};

/** The presence subject for an open flag: the dialog has no value to keep through its exit. */
function presenceKey(open: boolean): true | null {
  return open ? true : null;
}

/**
 * Asks for one public article URL.
 *
 * The dialog owns nothing privileged. It shapes the string, shows progress, and
 * renders whatever typed message main returns; every real decision — scheme,
 * port, credentials, resolved address, redirects, size, and content type —
 * belongs to main's address policy, which runs whatever this field believed.
 * The inline check exists so an obvious typo costs no round trip, not as a
 * security control.
 */
export function ImportWebArticleModal({
  open,
  onClose,
  onSubmit,
  folderId,
}: ImportWebArticleModalProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialogFocus(open, onClose);
  const { shown, phase } = useModalPresence(presenceKey(open));
  // A resolved import unmounts the dialog, so its own state setters must not
  // run afterwards; this also keeps a second Enter from starting a second fetch.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (open) {
      setUrl('');
      setError(null);
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }, [open]);

  if (shown === null) return null;

  async function handleSubmit() {
    if (inFlightRef.current) return;
    const trimmed = url.trim();
    const problem = webArticleUrlProblem(trimmed);
    if (problem !== null) {
      setError(problem);
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, { folderId });
      onClose();
    } catch (err) {
      inFlightRef.current = false;
      setSubmitting(false);
      setError(err instanceof Error ? err.message : 'Interleaf could not import that page.');
    }
  }

  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-article-modal-title"
        tabIndex={-1}
        data-testid="import-web-article-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-md rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <div className="flex items-center gap-2">
          <AppIcon name="import-from-web" className="text-accent" />
          <h2 id="web-article-modal-title" className="text-sm font-semibold text-text-primary">
            Import from web URL
          </h2>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Interleaf saves a clean, offline copy of the article text and the still images it can
          archive. Scripts, interactive embeds, and other active content are left behind.
        </p>

        <form
          noValidate
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <div>
            <label
              htmlFor="web-article-url-input"
              className="block text-xs font-medium text-text-secondary"
            >
              Article address
            </label>
            <input
              id="web-article-url-input"
              data-testid="web-article-url-input"
              type="url"
              inputMode="url"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? 'web-article-url-error' : 'web-article-url-hint'}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error !== null) setError(null);
              }}
              placeholder="https://example.com/article"
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-hidden disabled:opacity-60"
            />
            <p id="web-article-url-hint" className="mt-1 text-2xs text-text-secondary">
              Public http:// or https:// pages only.
            </p>
          </div>

          {error !== null && (
            <p
              id="web-article-url-error"
              data-testid="web-article-url-error"
              role="alert"
              className="text-xs text-danger"
            >
              {error}
            </p>
          )}

          {submitting && (
            <p
              data-testid="web-article-progress"
              role="status"
              aria-live="polite"
              className="text-xs text-text-secondary"
            >
              Fetching and cleaning the article…
            </p>
          )}

          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-testid="cancel-web-article-button"
              onClick={onClose}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-web-article-button"
              disabled={submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Importing…' : 'Import article'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
