import { describe, expect, it } from 'vitest';
import type { Session } from 'electron';
import react from '@vitejs/plugin-react';
import {
  CSP_DIRECTIVES,
  DEV_CSP_DIRECTIVES,
  VITE_REACT_REFRESH_PREAMBLE_HASH,
  computeViteReactRefreshPreambleHash,
  getContentSecurityPolicyForUrl,
  installContentSecurityPolicy,
  isDevOriginRequest,
  parseLocalDevOrigin,
} from '@main/security/csp';
import {
  createSecureWebPreferences,
  isNavigationAllowed,
  safeNavigationTargetForLog,
} from '@main/windows/main-window';
import { createSenderRule, isSenderAllowed } from '@main/ipc/sender-validation';
import { redactSecrets } from '@main/logging/logger';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('secure BrowserWindow web preferences', () => {
  it('enforces the mandatory Electron security profile', () => {
    const prefs = createSecureWebPreferences('/out/preload/index.js');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
    expect(prefs.preload.endsWith('preload/index.js')).toBe(true);
  });

  it('is frozen so flags cannot be mutated at runtime', () => {
    const prefs = createSecureWebPreferences('/out/preload/index.js');
    const mutable: { sandbox: boolean } = prefs;
    expect(() => {
      mutable.sandbox = false;
    }).toThrow();
  });
});

describe('content security policy', () => {
  it('locks production scripts to self and forbids objects, frames and remote origins', () => {
    expect(CSP_DIRECTIVES).toContain("default-src 'self'");
    expect(CSP_DIRECTIVES).toContain("script-src 'self'");
    expect(CSP_DIRECTIVES).not.toContain(VITE_REACT_REFRESH_PREAMBLE_HASH);
    expect(CSP_DIRECTIVES).not.toContain("'unsafe-eval'");
    expect(CSP_DIRECTIVES).toContain("worker-src 'self' blob:");
    expect(CSP_DIRECTIVES).toContain("object-src 'none'");
    expect(CSP_DIRECTIVES).toContain("media-src 'none'");
    expect(CSP_DIRECTIVES).not.toContain("media-src 'self'");
    expect(CSP_DIRECTIVES).toContain("frame-ancestors 'none'");
    expect(CSP_DIRECTIVES).toContain("connect-src 'self'");
    // The custom protocol is the only non-self resource scheme.
    expect(CSP_DIRECTIVES).toContain('interleaf-media:');
    expect(CSP_DIRECTIVES).not.toMatch(/https?:\/\//);
  });

  it('forbids interactive media in both header and renderer policies', () => {
    expect(DEV_CSP_DIRECTIVES).toContain("media-src 'none'");
    expect(DEV_CSP_DIRECTIVES).not.toContain("media-src 'self'");
    const rendererHtml = readFileSync(path.resolve('src/renderer/index.html'), 'utf8');
    expect(rendererHtml).toContain("media-src 'none'");
    expect(rendererHtml).not.toContain("media-src 'self'");
  });

  it('computes the expected hash directly from the @vitejs/plugin-react preambleCode', () => {
    expect(typeof react.preambleCode).toBe('string');
    const computedHash = computeViteReactRefreshPreambleHash(react.preambleCode);
    expect(computedHash).toBe(VITE_REACT_REFRESH_PREAMBLE_HASH);
    expect(VITE_REACT_REFRESH_PREAMBLE_HASH).toBe(
      "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"
    );
  });

  it('limits the dev preamble hash strictly to DEV_CSP_DIRECTIVES without unsafe-inline or unsafe-eval', () => {
    expect(DEV_CSP_DIRECTIVES).toContain(
      `script-src 'self' ${VITE_REACT_REFRESH_PREAMBLE_HASH}`
    );
    expect(DEV_CSP_DIRECTIVES).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(DEV_CSP_DIRECTIVES).not.toContain("'unsafe-eval'");
    expect(DEV_CSP_DIRECTIVES).toContain("object-src 'none'");
    expect(DEV_CSP_DIRECTIVES).toContain("frame-ancestors 'none'");
  });

  it('parses and validates local development origins strictly', () => {
    expect(parseLocalDevOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(parseLocalDevOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(parseLocalDevOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(parseLocalDevOrigin('http://[::1]:5173')).toBe('http://[::1]:5173');
    expect(parseLocalDevOrigin('https://localhost:5173')).toBe('https://localhost:5173');

    // Rejects non-local, foreign, or invalid URLs
    expect(parseLocalDevOrigin('https://evil.example.com/')).toBeUndefined();
    expect(parseLocalDevOrigin('http://192.168.1.50:5173')).toBeUndefined();
    expect(parseLocalDevOrigin('file:///etc/passwd')).toBeUndefined();
    expect(parseLocalDevOrigin('javascript:alert(1)')).toBeUndefined();
    expect(parseLocalDevOrigin('')).toBeUndefined();
    expect(parseLocalDevOrigin('   ')).toBeUndefined();
    expect(parseLocalDevOrigin(undefined)).toBeUndefined();
  });

  it('accurately matches exact dev origin requests and rejects prefix/subdomain spoofs', () => {
    const devOrigin = 'http://localhost:5173';
    expect(isDevOriginRequest('http://localhost:5173/', devOrigin)).toBe(true);
    expect(isDevOriginRequest('http://localhost:5173/src/main.tsx', devOrigin)).toBe(true);
    expect(isDevOriginRequest('http://localhost:5173/@react-refresh', devOrigin)).toBe(true);

    expect(isDevOriginRequest('http://localhost:5173.attacker.com/evil.js', devOrigin)).toBe(false);
    expect(isDevOriginRequest('http://localhost:3000/', devOrigin)).toBe(false);
    expect(isDevOriginRequest('http://127.0.0.1:5173/', devOrigin)).toBe(false);
    expect(isDevOriginRequest('file:///out/renderer/index.html', devOrigin)).toBe(false);
    expect(isDevOriginRequest('interleaf-media:///sample.pdf', devOrigin)).toBe(false);
    expect(isDevOriginRequest('https://evil.example.com/', devOrigin)).toBe(false);
    expect(isDevOriginRequest(undefined, devOrigin)).toBe(false);
    expect(isDevOriginRequest('http://localhost:5173/', undefined)).toBe(false);
  });

  it('resolves CSP per URL: production and unrelated origins remain strict while dev origin receives hash', () => {
    const devUrl = 'http://localhost:5173';

    // Production mode (no devUrl): all URLs get strict CSP_DIRECTIVES
    expect(getContentSecurityPolicyForUrl('http://localhost:5173/', undefined)).toBe(CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('file:///out/renderer/index.html', undefined)).toBe(CSP_DIRECTIVES);

    // Dev mode: exact dev origin gets DEV_CSP_DIRECTIVES
    expect(getContentSecurityPolicyForUrl('http://localhost:5173/', devUrl)).toBe(DEV_CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('http://localhost:5173/src/main.tsx', devUrl)).toBe(DEV_CSP_DIRECTIVES);

    // Dev mode: unrelated origins remain strictly CSP_DIRECTIVES
    expect(getContentSecurityPolicyForUrl('file:///out/renderer/index.html', devUrl)).toBe(CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('interleaf-media:///sample.pdf', devUrl)).toBe(CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('https://evil.example.com/', devUrl)).toBe(CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('http://localhost:3000/', devUrl)).toBe(CSP_DIRECTIVES);
    expect(getContentSecurityPolicyForUrl('http://localhost:5173.attacker.com/', devUrl)).toBe(CSP_DIRECTIVES);
  });

  it('installs the header callback, preserves existing response headers, and applies the scoped CSP', () => {
    type CallbackType = (
      details: { url?: string; responseHeaders?: Record<string, string[]> },
      done: (result: { responseHeaders: Record<string, string[]> }) => void
    ) => void;

    let listener: CallbackType | undefined;
    const fakeSession = {
      webRequest: {
        onHeadersReceived: (cb: CallbackType) => {
          listener = cb;
        },
      },
    } as Session;

    // 0. Production install: no dev-origin exception, existing headers kept
    installContentSecurityPolicy(fakeSession);
    let prodInstallResult: { responseHeaders: Record<string, string[]> } | undefined;
    listener!(
      { url: 'http://localhost:5173/', responseHeaders: { 'X-Test': ['1'] } },
      (res) => {
        prodInstallResult = res;
      }
    );
    expect(prodInstallResult?.responseHeaders['Content-Security-Policy']).toEqual([CSP_DIRECTIVES]);
    expect(prodInstallResult?.responseHeaders['X-Test']).toEqual(['1']);

    installContentSecurityPolicy(fakeSession, { devUrl: 'http://localhost:5173' });
    expect(listener).toBeDefined();

    // 1. Dev origin response with existing headers
    let devResult: { responseHeaders: Record<string, string[]> } | undefined;
    listener!(
      {
        url: 'http://localhost:5173/',
        responseHeaders: {
          'Content-Type': ['text/html; charset=utf-8'],
          'X-Custom-Header': ['custom-value'],
        },
      },
      (res) => {
        devResult = res;
      }
    );
    expect(devResult?.responseHeaders['Content-Type']).toEqual(['text/html; charset=utf-8']);
    expect(devResult?.responseHeaders['X-Custom-Header']).toEqual(['custom-value']);
    expect(devResult?.responseHeaders['Content-Security-Policy']).toEqual([DEV_CSP_DIRECTIVES]);

    // 2. Production file response
    let prodResult: { responseHeaders: Record<string, string[]> } | undefined;
    listener!(
      {
        url: 'file:///out/renderer/index.html',
        responseHeaders: { 'Content-Type': ['text/html'] },
      },
      (res) => {
        prodResult = res;
      }
    );
    expect(prodResult?.responseHeaders['Content-Type']).toEqual(['text/html']);
    expect(prodResult?.responseHeaders['Content-Security-Policy']).toEqual([CSP_DIRECTIVES]);

    // 3. Foreign origin in dev mode
    let foreignResult: { responseHeaders: Record<string, string[]> } | undefined;
    listener!(
      {
        url: 'https://evil.example.com/',
        responseHeaders: {},
      },
      (res) => {
        foreignResult = res;
      }
    );
    expect(foreignResult?.responseHeaders['Content-Security-Policy']).toEqual([CSP_DIRECTIVES]);
  });
});

describe('navigation policy', () => {
  it('allows only the exact dev server origin in development', () => {
    expect(isNavigationAllowed('http://localhost:5173/src/main.tsx', 'http://localhost:5173')).toBe(
      true
    );
    expect(isNavigationAllowed('http://localhost:5173.attacker', 'http://localhost:5173')).toBe(false);
  });

  it('blocks every navigation in production builds', () => {
    expect(isNavigationAllowed('http://localhost:5173/')).toBe(false);
    expect(isNavigationAllowed('https://evil.example.com/', undefined)).toBe(false);
    expect(isNavigationAllowed('file:///etc/passwd', 'http://localhost:5173')).toBe(false);
  });

  it('redacts navigation credentials, paths, queries, and fragments from logs', () => {
    expect(
      safeNavigationTargetForLog('https://user:secret@example.com/private/token?key=abc#fragment')
    ).toBe('https://example.com');
    expect(safeNavigationTargetForLog('file:///Users/example/private.pdf')).toBe(
      'file://[redacted]'
    );
    expect(safeNavigationTargetForLog('not a url')).toBe('<malformed-url>');
  });
});

describe('IPC sender validation', () => {
  const indexHtmlPath = '/abs/path/out/renderer/index.html';
  const prodRule = createSenderRule({ indexHtmlPath });
  const devRule = createSenderRule({
    devUrl: 'http://localhost:5173',
    indexHtmlPath,
  });

  it('accepts frames served from the exact packaged index.html in production', () => {
    const frame = { url: prodRule.allowedProductionFileUrl } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: frame }, prodRule)).toBe(true);
  });

  it('accepts frames from the exact dev server origin in development', () => {
    const frame = { url: 'http://localhost:5173/' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: frame }, devRule)).toBe(true);
    const subframe = { url: 'http://localhost:5173/subpath' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: subframe }, devRule)).toBe(true);
  });

  it('rejects foreign origins and prefix tricks in development', () => {
    const evil1 = { url: 'http://localhost:5173.evil.com/' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: evil1 }, devRule)).toBe(false);
    const suffixed = { url: 'http://localhost:5173.attacker/' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: suffixed }, devRule)).toBe(false);
    const evil2 = { url: 'http://localhost:3000/' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: evil2 }, devRule)).toBe(false);
  });

  it('rejects foreign origins and frameless events in production', () => {
    const foreign = { url: 'https://evil.example.com/' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: foreign }, prodRule)).toBe(false);
    expect(isSenderAllowed({ senderFrame: null }, prodRule)).toBe(false);
    const empty = { url: '' } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: empty }, prodRule)).toBe(false);
  });

  it('rejects other production files even when they share the index prefix', () => {
    const prefix = { url: `${prodRule.allowedProductionFileUrl}.evil` } as import('electron').WebFrameMain;
    expect(isSenderAllowed({ senderFrame: prefix }, prodRule)).toBe(false);
  });
});

describe('structured log redaction', () => {
  it('recursively scrubs secret keys, token-shaped values, and user home paths', () => {
    expect(
      redactSecrets({
        nested: { authorization: 'Bearer abcdefghijklmnop', note: 'token=supersecretvalue' },
        url: 'failed under /Users/alice/private/project',
        apiKey: 'plain-secret',
      })
    ).toEqual({
      nested: { authorization: '[redacted]', note: '[redacted]' },
      url: 'failed under /[user-home]/private/project',
      apiKey: '[redacted]',
    });
  });
});
