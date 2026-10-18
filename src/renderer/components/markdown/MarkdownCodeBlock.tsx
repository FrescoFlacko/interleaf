import { useEffect, useMemo, useRef, useState } from 'react';
import { AppIcon, type AppIconName } from '../AppIcon';
import { parseCodeFenceInfo } from './code-fence-info';
import { bridge } from '../../app/api-client';

/** How long the copy control stays in its success state. */
const COPY_RESET_MS = 1_000;

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_TEXT: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};

const COPY_ACCESSIBLE_NAME: Record<CopyState, string> = {
  idle: 'Copy code',
  copied: 'Code copied to the clipboard',
  failed: 'Copy failed. Try again.',
};

/** Empty while idle so the live region only speaks after an interaction. */
const COPY_ANNOUNCEMENT: Record<CopyState, string> = {
  idle: '',
  copied: 'Code copied to the clipboard.',
  failed: 'Copying the code failed.',
};

const COPY_ICON: Record<CopyState, AppIconName> = {
  idle: 'copy',
  copied: 'copy-success',
  failed: 'copy',
};

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    const result = await bridge.clipboard.writeText(text);
    return result.copied;
  } catch {
    return false;
  }
}

/**
 * Copy state for one code block.
 *
 * Presses are sequenced: each one takes the next attempt number, and only the
 * attempt that is still the latest may report a result or schedule the reset
 * timer. Two overlapping clipboard writes can therefore settle in any order
 * without an older result overwriting the newer one, and because the single
 * tracked timer is cleared before another is stored — on every press, on every
 * settled result, and on unmount — no orphan timer can survive to touch an
 * unmounted block. Until the latest attempt settles the control reads as idle
 * rather than keeping an earlier "Copied" that no longer describes it, and a
 * failed copy is reported as a failure and never presented as a success.
 */
function useCopyCode(code: string): { readonly state: CopyState; readonly copy: () => void } {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(true);
  const latestAttempt = useRef(0);

  const clearTimer = (): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      clearTimer();
    };
  }, []);

  const copy = (): void => {
    const attempt = latestAttempt.current + 1;
    latestAttempt.current = attempt;
    clearTimer();
    setState('idle');
    void writeToClipboard(code).then((copied) => {
      if (!liveRef.current || attempt !== latestAttempt.current) return;
      clearTimer();
      setState(copied ? 'copied' : 'failed');
      if (!copied) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (liveRef.current) setState('idle');
      }, COPY_RESET_MS);
    });
  };

  return { state, copy };
}

function CodeBlockFilename({ filename }: { readonly filename: string | null }) {
  if (filename === null) return null;
  return (
    <span
      data-testid="markdown-code-filename"
      title={filename}
      className="min-w-0 truncate font-mono text-text-primary"
    >
      {filename}
    </span>
  );
}

function CopyCodeButton({ state, onCopy }: { readonly state: CopyState; readonly onCopy: () => void }) {
  return (
    <>
      <button
        type="button"
        data-testid="markdown-copy-code"
        data-copy-state={state}
        onClick={onCopy}
        aria-label={COPY_ACCESSIBLE_NAME[state]}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary hover:bg-bg-surface hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        <AppIcon name={COPY_ICON[state]} size={12} />
        <span aria-hidden="true">{COPY_TEXT[state]}</span>
      </button>
      <span role="status" aria-live="polite" data-testid="markdown-copy-status" className="sr-only">
        {COPY_ANNOUNCEMENT[state]}
      </span>
    </>
  );
}

/**
 * A fenced code block with a header.
 *
 * The header states what the fence itself declared — a language label with a
 * matching icon, plus a filename only where the metadata supplied one — and
 * carries the copy control. The code is rendered as text, exactly as before:
 * this component adds chrome around the sanitized Markdown pipeline and changes
 * nothing about it.
 */
export function MarkdownCodeBlock({ code, info }: { readonly code: string; readonly info: string }) {
  const fence = useMemo(() => parseCodeFenceInfo(info), [info]);
  const { state, copy } = useCopyCode(code);

  return (
    <div className="my-2 max-w-full overflow-hidden rounded border border-border-subtle bg-bg-primary">
      <div
        data-testid="markdown-code-header"
        className="flex items-center gap-2 border-b border-border-subtle px-2 py-1 text-2xs text-text-secondary"
      >
        <AppIcon name="code-block" size={12} />
        <span data-testid="markdown-code-language" className="shrink-0 font-mono uppercase tracking-wide">
          {fence.language}
        </span>
        <CodeBlockFilename filename={fence.filename} />
        <CopyCodeButton state={state} onCopy={copy} />
      </div>
      <pre className="max-w-full overflow-x-auto p-2 text-2xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
