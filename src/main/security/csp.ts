import { createHash } from 'node:crypto';
import type { Session } from 'electron';

/**
 * Content Security Policy enforced on every renderer response
 * (docs/SECURITY.md §3). `interleaf-media:` is the only non-self resource
 * scheme; remote origins are never allowed.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' interleaf-media: data: blob:",
  "media-src 'none'",
  "font-src 'self' data:",
  "connect-src 'self' interleaf-media:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * SHA-256 hash of the Vite React Fast Refresh preamble script:
 * `import { injectIntoGlobalHook } from "/@react-refresh";\ninjectIntoGlobalHook(window);\nwindow.$RefreshReg$ = () => {};\nwindow.$RefreshSig$ = () => (type) => type;`
 *
 * In development, Vite injects this inline script for React Fast Refresh.
 * This exact hash is permitted ONLY for responses from the configured local
 * dev server origin. 'unsafe-inline' is NEVER permitted for scripts.
 */
export const VITE_REACT_REFRESH_PREAMBLE_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

/**
 * Content Security Policy for development responses served from the exact
 * configured local dev server origin. All directives remain identical to
 * production except script-src includes the exact preamble hash.
 */
export const DEV_CSP_DIRECTIVES = [
  "default-src 'self'",
  `script-src 'self' ${VITE_REACT_REFRESH_PREAMBLE_HASH}`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' interleaf-media: data: blob:",
  "media-src 'none'",
  "font-src 'self' data:",
  "connect-src 'self' interleaf-media:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export type ContentSecurityPolicyOptions = {
  /** Dev server origin (electron-vite sets ELECTRON_RENDERER_URL in dev). */
  readonly devUrl?: string | undefined;
};

/**
 * Computes the SHA-256 CSP hash for a given preamble code template.
 * Replaces __BASE__ with '/' to match standard Vite dev server injection.
 */
export function computeViteReactRefreshPreambleHash(
  preambleCodeTemplate = `import { injectIntoGlobalHook } from "/@react-refresh";\ninjectIntoGlobalHook(window);\nwindow.$RefreshReg$ = () => {};\nwindow.$RefreshSig$ = () => (type) => type;`
): string {
  const code = preambleCodeTemplate.replace('__BASE__', '/');
  const hash = createHash('sha256').update(code).digest('base64');
  return `'sha256-${hash}'`;
}

/**
 * Validates that a dev URL is a valid local origin (localhost, 127.0.0.1, ::1).
 * Returns the canonical origin or undefined if not a valid local dev URL.
 */
export function parseLocalDevOrigin(devUrl?: string): string | undefined {
  if (!devUrl || devUrl.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(devUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname === '0.0.0.0';
    if (!isLocalHost) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Checks if a request URL matches the exact configured local development origin.
 */
export function isDevOriginRequest(
  requestUrl: string | undefined,
  allowedDevOrigin: string | undefined
): boolean {
  if (!requestUrl || !allowedDevOrigin || allowedDevOrigin.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(requestUrl);
    return parsed.origin === allowedDevOrigin;
  } catch {
    return false;
  }
}

/**
 * Resolves the Content Security Policy for a given request URL and devUrl setting.
 */
export function getContentSecurityPolicyForUrl(
  requestUrl: string | undefined,
  devUrl?: string
): string {
  const allowedDevOrigin = parseLocalDevOrigin(devUrl);
  if (isDevOriginRequest(requestUrl, allowedDevOrigin)) {
    return DEV_CSP_DIRECTIVES;
  }
  return CSP_DIRECTIVES;
}

export function installContentSecurityPolicy(
  session: Session,
  options?: ContentSecurityPolicyOptions | string
): void {
  const devUrl = typeof options === 'string' ? options : options?.devUrl;
  const allowedDevOrigin = parseLocalDevOrigin(devUrl);

  session.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDevOriginRequest(details.url, allowedDevOrigin)
      ? DEV_CSP_DIRECTIVES
      : CSP_DIRECTIVES;

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}
