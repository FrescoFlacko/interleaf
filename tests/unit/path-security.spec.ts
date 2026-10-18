import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizeWithinRoots, isPathWithin, isStrictlyInside, relativePathWithin, resolveMediaUrlTarget } from '@main/security/path-guard';
import { AssetRegistry } from '@main/security/asset-registry';

describe('Adversarial Path Security & Containment Audit (Phase 11)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'interleaf-path-audit-'));
  const libraryRoot = path.join(tmp, 'library');
  const outsideSecretDir = path.join(tmp, 'outside-secret');
  const siblingRoot = `${libraryRoot}-sibling`;

  mkdirSync(libraryRoot, { recursive: true });
  mkdirSync(outsideSecretDir, { recursive: true });
  mkdirSync(siblingRoot, { recursive: true });

  const insideFile = path.join(libraryRoot, 'valid.pdf');
  const outsideFile = path.join(outsideSecretDir, 'shadow.txt');
  const siblingFile = path.join(siblingRoot, 'sibling.pdf');

  writeFileSync(insideFile, '%PDF-1.4 sample content');
  writeFileSync(outsideFile, 'secret-data');
  writeFileSync(siblingFile, '%PDF-1.4 sibling content');

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('canonicalizeWithinRoots', () => {
    it('allows valid contained file and resolves real canonical path', () => {
      const result = canonicalizeWithinRoots(insideFile, [libraryRoot]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedPath).toBe(realpathSync(insideFile));
      }
    });

    it('rejects sibling directory with matching string prefix', () => {
      // Sibling prefix attack: /path/to/library-sibling must not match permitted root /path/to/library
      const result = canonicalizeWithinRoots(siblingFile, [libraryRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toBe('outside-permitted-roots');
      }
    });

    it.each([
      '../outside-secret/shadow.txt',
      '../../../../../../../../etc/passwd',
      'sub/../../outside-secret/shadow.txt',
      './../outside-secret/shadow.txt',
      '..',
    ])('rejects relative traversal attempts: %s', (traversalPath) => {
      const candidate = path.join(libraryRoot, traversalPath);
      const result = canonicalizeWithinRoots(candidate, [libraryRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toBe('outside-permitted-roots');
      }
    });

    it('rejects null-byte injection and empty paths', () => {
      const candidate = `${insideFile}\0.txt`;
      const result = canonicalizeWithinRoots(candidate, [libraryRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toBe('null-byte');
      }
      expect(canonicalizeWithinRoots('', [libraryRoot]).ok).toBe(false);
    });

    it('rejects absolute paths outside permitted roots', () => {
      const result = canonicalizeWithinRoots(outsideFile, [libraryRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toBe('outside-permitted-roots');
      }
    });

    it('detects symlink pointing outside permitted root', () => {
      const symlinkPath = path.join(libraryRoot, 'escape-link.pdf');
      symlinkSync(outsideFile, symlinkPath);
      const result = canonicalizeWithinRoots(symlinkPath, [libraryRoot]);
      expect(result.ok).toBe(false);
    });

    it('detects chained symlink escapes', () => {
      const intermediateLink = path.join(tmp, 'intermediate-link.pdf');
      symlinkSync(outsideFile, intermediateLink);
      const chainedLink = path.join(libraryRoot, 'chained-link.pdf');
      symlinkSync(intermediateLink, chainedLink);

      const result = canonicalizeWithinRoots(chainedLink, [libraryRoot]);
      expect(result.ok).toBe(false);
    });
  });

  describe('lexical containment helpers', () => {
    it('returns the contained relative path, or an empty path for the root itself', () => {
      expect(relativePathWithin(libraryRoot, insideFile)).toBe('valid.pdf');
      expect(relativePathWithin(libraryRoot, libraryRoot)).toBe('');
      expect(isPathWithin(libraryRoot, libraryRoot)).toBe(true);
      expect(isStrictlyInside(libraryRoot, libraryRoot)).toBe(false);
      expect(isStrictlyInside(libraryRoot, insideFile)).toBe(true);
    });

    it('rejects traversal, sibling prefixes and paths outside the root', () => {
      expect(relativePathWithin(libraryRoot, path.join(libraryRoot, '..', 'outside-secret'))).toBeNull();
      expect(relativePathWithin(libraryRoot, tmp)).toBeNull();
      expect(relativePathWithin(libraryRoot, siblingFile)).toBeNull();
      expect(isPathWithin(libraryRoot, outsideFile)).toBe(false);
      expect(isStrictlyInside(libraryRoot, outsideFile)).toBe(false);
    });

    it('keeps an ordinary name that only begins with two dots', () => {
      expect(relativePathWithin(libraryRoot, path.join(libraryRoot, '..hidden'))).toBe('..hidden');
    });

    it('rejects a path on another Windows drive under win32 semantics', () => {
      expect(relativePathWithin('C:\\Windows', 'C:\\Windows\\System32\\taskkill.exe', path.win32)).toBe('System32\\taskkill.exe');
      expect(relativePathWithin('C:\\Windows', 'D:\\Windows\\System32', path.win32)).toBeNull();
      expect(relativePathWithin('C:\\Windows', 'C:\\Windows\\..\\Users', path.win32)).toBeNull();
    });

    it('does not follow a symlink, so callers compare canonical paths', () => {
      const link = path.join(libraryRoot, 'lexical-escape');
      symlinkSync(outsideSecretDir, link);
      expect(isStrictlyInside(libraryRoot, path.join(link, 'shadow.txt'))).toBe(true);
      expect(isStrictlyInside(realpathSync(libraryRoot), realpathSync(path.join(link, 'shadow.txt')))).toBe(false);
    });
  });

  describe('resolveMediaUrlTarget', () => {
    it('resolves valid interleaf-media URLs within roots', () => {
      const mediaUrl = `interleaf-media:///${encodeURIComponent(insideFile.replace(/^[/\\]+/, ''))}`;
      const result = resolveMediaUrlTarget(mediaUrl, [libraryRoot]);
      expect(result.ok).toBe(true);
    });

    it.each([
      'interleaf-media:///../../etc/passwd',
      'interleaf-media:///%2e%2e/%2e%2e/etc/passwd',
      'interleaf-media:///%252e%252e/%252e%252e/etc/passwd',
      'interleaf-media:///..%2f..%2fetc%2fpasswd',
      `interleaf-media:///${encodeURIComponent('../'.repeat(12))}etc/passwd`,
      'file:///etc/passwd',
      'http://attacker.com/malicious.pdf',
      'javascript:alert(1)',
      'data:text/html,evil',
      'interleaf-media:///%zz-invalid-hex',
    ])('rejects adversarial media URL: %s', (url) => {
      const result = resolveMediaUrlTarget(url, [libraryRoot]);
      expect(result.ok).toBe(false);
    });

    it('treats non-library absolute paths as forbidden, not found', () => {
      const result = resolveMediaUrlTarget('interleaf-media:///etc/passwd', [libraryRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toBe('outside-permitted-roots');
      }
    });
  });

  describe('AssetRegistry containment and expiry', () => {
    it('rejects registering an asset file that is a symlink pointing outside root', async () => {
      const registry = new AssetRegistry([libraryRoot]);
      const scopeId = 'test-scope';

      const symlinkVictim = path.join(libraryRoot, 'swapped-victim.pdf');
      // Create symlink pointing outside
      symlinkSync(outsideFile, symlinkVictim);

      // Registration must fail closed because symlink resolves outside permitted root
      await expect(
        registry.registerAsset({
          documentId: 'doc-security-1',
          scopeId,
          filePath: symlinkVictim,
          permittedRoot: libraryRoot,
        })
      ).rejects.toThrow();
    });

    it('enforces TTL expiration and auto-purges stale asset records', async () => {
      const registry = new AssetRegistry([libraryRoot]);
      const scopeId = 'scope-ttl-test';
      const docId = 'doc-ttl-1';

      registry.activateDocument(scopeId, docId);
      const { assetId } = await registry.registerAsset({
        documentId: docId,
        scopeId,
        filePath: insideFile,
        permittedRoot: libraryRoot,
        ttlMs: 20, // 20ms TTL
      });

      expect(registry.resolveAsset(assetId, scopeId)).not.toBeNull();

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 40));
      expect(registry.resolveAsset(assetId, scopeId)).toBeNull();
    });
  });
});
