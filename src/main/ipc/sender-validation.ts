import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Sender validation for IPC handlers (AGENTS.md §2). Only frames loaded from
 * the Interleaf app itself — the Vite dev server origin in development or the
 * exact packaged `index.html` file URL in production — may invoke channels.
 *
 * Invariant: Prefix comparisons are forbidden. Verification uses exact origin
 * matching for dev URLs and exact canonical file matching for packaged builds.
 */

/**
 * What sender validation reads about the frame that made the call: its URL,
 * and nothing else. Electron's `WebFrameMain` answers this, so the real event
 * passes unchanged, and a test can name the sender it is describing without
 * standing up a frame.
 */
type SenderFrame = { readonly url: string };

/** The part of an invoke event sender validation reads. */
export type SenderEvent = { readonly senderFrame: SenderFrame | null };

export type SenderRule = {
  readonly allowedDevOrigin: string | undefined;
  readonly allowedProductionFileUrl: string;
  readonly allowedProductionFilePath: string;
};

export type SenderRuleContext = {
  /** Dev server origin, e.g. `http://localhost:5173`. Undefined in production. */
  readonly devUrl?: string | undefined;
  /** Absolute path of the packaged renderer `index.html`. */
  readonly indexHtmlPath: string;
};

export function createSenderRule(context: SenderRuleContext): SenderRule {
  const canonicalHtmlPath = resolve(context.indexHtmlPath);
  const fileUrl = pathToFileURL(canonicalHtmlPath).href;

  let devOrigin: string | undefined;
  if (context.devUrl && context.devUrl.trim().length > 0) {
    try {
      devOrigin = new URL(context.devUrl).origin;
    } catch {
      devOrigin = undefined;
    }
  }

  return {
    allowedDevOrigin: devOrigin,
    allowedProductionFileUrl: fileUrl,
    allowedProductionFilePath: canonicalHtmlPath,
  };
}

export function isSenderAllowed(
  event: SenderEvent,
  rule: SenderRule
): boolean {
  const frame = event.senderFrame;
  if (frame === null) {
    return false;
  }
  const rawUrl = frame.url;
  if (!rawUrl || rawUrl.length === 0) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  // 1. Development Vite server exact origin match
  if (rule.allowedDevOrigin !== undefined) {
    if (parsed.origin === rule.allowedDevOrigin) {
      return true;
    }
  }

  // 2. Production file:// protocol exact file match
  if (parsed.protocol === 'file:') {
    // Strip hash and query for exact path comparison
    const sanitizedHref = `${parsed.protocol}//${parsed.pathname}`;
    if (sanitizedHref === rule.allowedProductionFileUrl) {
      return true;
    }
    try {
      const decodedPath = resolve(fileURLToPath(rawUrl));
      return decodedPath === rule.allowedProductionFilePath;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Sanitizes a frame URL for safe logging without leaking raw paths or query tokens.
 */
export function sanitizeSenderForLog(rawUrl: string | undefined | null): string {
  if (!rawUrl) {
    return '<no-frame>';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
    if (parsed.protocol === 'file:') {
      return 'file://[packaged-renderer]';
    }
    return `${parsed.protocol}//[redacted]`;
  } catch {
    return '<malformed-url>';
  }
}
