import { afterAll, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetRegistry } from '@main/security/asset-registry';
import {
  createMediaProtocolHandler,
  extractAssetIdFromUrl,
  parseSingleByteRange,
} from '@main/security/protocol-handler';
import type { Logger } from '@main/logging/logger';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const SCOPE_ID = 'scope-test';

describe('AssetRegistry (ADR-0011)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-asset-registry-'));
  const libraryDir = path.join(tmpDir, 'library');
  const outsideDir = path.join(tmpDir, 'outside');
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const insidePdf = path.join(libraryDir, 'sample.pdf');
  writeFileSync(insidePdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

  const outsideSecret = path.join(outsideDir, 'secret.key');
  writeFileSync(outsideSecret, 'super-secret');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers valid files within permitted roots and returns opaque media URLs', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const result = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-123',
      scopeId: SCOPE_ID,
    });

    expect(result.assetId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.mediaUrl).toBe(`interleaf-media://${result.assetId}`);

    registry.activateDocument(SCOPE_ID, 'doc-123');
    const resolved = registry.resolveAsset(result.assetId, SCOPE_ID);
    expect(resolved).not.toBeNull();
    expect(resolved?.documentId).toBe('doc-123');
    expect(resolved?.mimeType).toBe('application/pdf');
    expect(resolved?.canonicalPath).toBe(realpathSync(insidePdf));
  });

  it('rejects files outside the permitted root', async () => {
    const registry = new AssetRegistry([libraryDir]);
    await expect(
      registry.registerAsset({
        filePath: outsideSecret,
        permittedRoot: libraryDir,
        documentId: 'doc-123',
        scopeId: SCOPE_ID,
      })
    ).rejects.toThrow(/permitted root/i);
  });

  it('rejects non-existent files', async () => {
    const registry = new AssetRegistry([libraryDir]);
    await expect(
      registry.registerAsset({
        filePath: path.join(libraryDir, 'missing.pdf'),
        permittedRoot: libraryDir,
        documentId: 'doc-123',
        scopeId: SCOPE_ID,
      })
    ).rejects.toThrow(/could not be resolved/i);
  });

  it('requires bounded expiry and sweeps expired assets', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const result = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-expiring',
      scopeId: SCOPE_ID,
      ttlMs: 10,
    });
    expect(registry.sweepExpired(Date.now() + 20)).toBe(1);
    expect(registry.resolveAsset(result.assetId, SCOPE_ID)).toBeNull();
    await expect(
      registry.registerAsset({
        filePath: insidePdf,
        permittedRoot: libraryDir,
        documentId: 'doc-invalid-ttl',
        scopeId: SCOPE_ID,
        ttlMs: 0,
      })
    ).rejects.toThrow(/expiry/i);
  });

  it('unregisters assets individually and by document ID', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const a1 = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-A',
      scopeId: SCOPE_ID,
    });
    await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-A',
      scopeId: SCOPE_ID,
    });
    const b1 = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-B',
      scopeId: SCOPE_ID,
    });

    expect(registry.size).toBe(3);

    expect(registry.unregisterAsset(a1.assetId)).toBe(true);
    expect(registry.size).toBe(2);

    const removed = registry.unregisterDocument('doc-A');
    expect(removed).toBe(1);
    expect(registry.size).toBe(1);
    registry.activateDocument(SCOPE_ID, 'doc-B');
    expect(registry.resolveAsset(b1.assetId, SCOPE_ID)).not.toBeNull();
  });

  it('binds capabilities to a renderer/document scope', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const asset = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-scoped',
      scopeId: SCOPE_ID,
    });
    registry.activateDocument(SCOPE_ID, 'doc-scoped');
    expect(registry.resolveAsset(asset.assetId, 'other-scope')).toBeNull();
    expect(registry.resolveAsset(asset.assetId, SCOPE_ID)).not.toBeNull();
    expect(registry.resolveAsset('invalid-asset-id', SCOPE_ID)).toBeNull();
    expect(registry.unregisterScope(SCOPE_ID)).toBeGreaterThan(0);
    expect(registry.resolveAsset(asset.assetId, SCOPE_ID)).toBeNull();
  });

  it('allows a library-cover capability without opening the document reader', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const asset = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-cover',
      scopeId: SCOPE_ID,
      kind: 'library-cover',
    });

    expect(registry.resolveAsset(asset.assetId, SCOPE_ID)).not.toBeNull();
    const handler = createMediaProtocolHandler({
      assetRegistry: registry,
      currentScopeId: () => SCOPE_ID,
      log: silentLog,
    });
    const response = await handler(new Request(asset.mediaUrl));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('%PDF-1.4');
  });

  it('deduplicates and renews cover capabilities while bounding the registry', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const first = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-cover-repeat',
      scopeId: SCOPE_ID,
      kind: 'library-cover',
      ttlMs: 1_000,
    });
    const firstExpiry = registry.resolveAsset(first.assetId, SCOPE_ID)?.expiresAt ?? 0;

    await new Promise((resolve) => setTimeout(resolve, 2));
    const repeated = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-cover-repeat',
      scopeId: SCOPE_ID,
      kind: 'library-cover',
      ttlMs: 60_000,
    });
    expect(repeated.assetId).toBe(first.assetId);
    expect(registry.resolveAsset(repeated.assetId, SCOPE_ID)?.expiresAt ?? 0).toBeGreaterThan(firstExpiry);

    for (let index = 0; index < 512; index += 1) {
      await registry.registerAsset({
        filePath: insidePdf,
        permittedRoot: libraryDir,
        documentId: `doc-cover-${String(index)}`,
        scopeId: SCOPE_ID,
        kind: 'library-cover',
      });
    }

    expect(registry.size).toBeLessThanOrEqual(512);
    expect(registry.resolveAsset(first.assetId, SCOPE_ID)).toBeNull();
  });

  it('revokes a closed document only in the requested renderer scope', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const scopeA = 'scope-a';
    const scopeB = 'scope-b';
    const assetA = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'shared-doc',
      scopeId: scopeA,
    });
    const assetB = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'shared-doc',
      scopeId: scopeB,
    });
    registry.activateDocument(scopeA, 'shared-doc');
    registry.activateDocument(scopeB, 'shared-doc');

    expect(registry.unregisterDocumentInScope('shared-doc', scopeA)).toBe(1);
    expect(registry.resolveAsset(assetA.assetId, scopeA)).toBeNull();
    expect(registry.resolveAsset(assetB.assetId, scopeB)).not.toBeNull();
  });

  it('revokes the previous document capabilities when a scope switches documents', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const first = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-first',
      scopeId: SCOPE_ID,
    });
    const second = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-second',
      scopeId: SCOPE_ID,
    });

    registry.activateDocument(SCOPE_ID, 'doc-first');
    expect(registry.resolveAsset(first.assetId, SCOPE_ID)).not.toBeNull();
    expect(registry.resolveAsset(second.assetId, SCOPE_ID)).toBeNull();

    expect(registry.activateDocument(SCOPE_ID, 'doc-second')).toBe(1);
    expect(registry.resolveAsset(first.assetId, SCOPE_ID)).toBeNull();
    expect(registry.resolveAsset(second.assetId, SCOPE_ID)).not.toBeNull();
  });

  it('keeps library-cover capabilities alive across reader switches and close', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const cover = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-cover-kept',
      scopeId: SCOPE_ID,
      kind: 'library-cover',
    });
    const reader = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-cover-kept',
      scopeId: SCOPE_ID,
    });

    registry.activateDocument(SCOPE_ID, 'doc-cover-kept');
    registry.activateDocument(SCOPE_ID, 'doc-next');
    expect(registry.resolveAsset(reader.assetId, SCOPE_ID)).toBeNull();
    expect(registry.resolveAsset(cover.assetId, SCOPE_ID)).not.toBeNull();

    expect(registry.unregisterDocumentInScope('doc-cover-kept', SCOPE_ID)).toBe(0);
    expect(registry.resolveAsset(cover.assetId, SCOPE_ID)).not.toBeNull();
    expect(registry.unregisterDocument('doc-cover-kept')).toBe(1);
    expect(registry.resolveAsset(cover.assetId, SCOPE_ID)).toBeNull();
  });

  it('revokes an older capability when the same document is reopened', async () => {
    const registry = new AssetRegistry([libraryDir]);
    registry.activateDocument(SCOPE_ID, 'doc-reopened');
    const previous = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-reopened',
      scopeId: SCOPE_ID,
    });

    expect(registry.activateDocument(SCOPE_ID, 'doc-reopened')).toBe(1);
    expect(registry.resolveAsset(previous.assetId, SCOPE_ID)).toBeNull();
  });

  it('rejects non-allowlisted types including raw SVG', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const svg = path.join(libraryDir, 'unsafe.svg');
    writeFileSync(svg, '<svg><script>alert(1)</script></svg>');
    await expect(
      registry.registerAsset({
        filePath: svg,
        permittedRoot: libraryDir,
        documentId: 'doc-svg',
        scopeId: SCOPE_ID,
      })
    ).rejects.toThrow(/allowlisted/i);
  });

  it('streams real assets with full, range, HEAD, and scope enforcement', async () => {
    const registry = new AssetRegistry([libraryDir]);
    const asset = await registry.registerAsset({
      filePath: insidePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-stream',
      scopeId: SCOPE_ID,
    });
    registry.activateDocument(SCOPE_ID, 'doc-stream');
    const handler = createMediaProtocolHandler({
      assetRegistry: registry,
      currentScopeId: () => SCOPE_ID,
      log: silentLog,
    });

    const full = await handler(new Request(asset.mediaUrl));
    expect(full.status).toBe(200);
    expect(await full.text()).toContain('%PDF-1.4');

    const partial = await handler(
      new Request(asset.mediaUrl, { headers: { Range: 'bytes=0-3' } })
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-3\//);
    expect(await partial.text()).toBe('%PDF');

    const head = await handler(new Request(asset.mediaUrl, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const wrongScopeHandler = createMediaProtocolHandler({
      assetRegistry: registry,
      currentScopeId: () => 'wrong-scope',
      log: silentLog,
    });
    expect((await wrongScopeHandler(new Request(asset.mediaUrl))).status).toBe(404);
  });

  it('keeps stalled streaming bounded and closes the stream on response cancellation', async () => {
    const largePdf = path.join(libraryDir, 'large.pdf');
    writeFileSync(largePdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024)]));
    const registry = new AssetRegistry([libraryDir]);
    const asset = await registry.registerAsset({
      filePath: largePdf,
      permittedRoot: libraryDir,
      documentId: 'doc-large',
      scopeId: SCOPE_ID,
    });
    registry.activateDocument(SCOPE_ID, 'doc-large');

    let createdStream: import('node:stream').Readable | undefined;
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const handler = createMediaProtocolHandler({
      assetRegistry: registry,
      currentScopeId: () => SCOPE_ID,
      log: silentLog,
      onNodeStreamCreated: (stream) => {
        createdStream = stream;
      },
      onNodeStreamClosed: () => {
        markClosed?.();
      },
    });

    const response = await handler(new Request(asset.mediaUrl));
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    expect(createdStream).toBeDefined();
    expect(createdStream?.readableLength ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64 * 1024);
    await response.body?.cancel('test cancellation');
    await closed;
    expect(createdStream?.destroyed).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an intermediate directory replaced by a symlink after registration',
    async () => {
      const raceDirectory = path.join(libraryDir, 'race-directory');
      const movedDirectory = path.join(libraryDir, 'race-directory-original');
      const outsideRaceDirectory = path.join(outsideDir, 'race-directory');
      mkdirSync(raceDirectory);
      mkdirSync(outsideRaceDirectory);
      const registeredPdf = path.join(raceDirectory, 'race.pdf');
      writeFileSync(registeredPdf, '%PDF-inside');
      writeFileSync(path.join(outsideRaceDirectory, 'race.pdf'), '%PDF-outside');

      const registry = new AssetRegistry([libraryDir]);
      const asset = await registry.registerAsset({
        filePath: registeredPdf,
        permittedRoot: libraryDir,
        documentId: 'doc-race',
        scopeId: SCOPE_ID,
      });
      registry.activateDocument(SCOPE_ID, 'doc-race');
      renameSync(raceDirectory, movedDirectory);
      symlinkSync(outsideRaceDirectory, raceDirectory, 'dir');

      const handler = createMediaProtocolHandler({
        assetRegistry: registry,
        currentScopeId: () => SCOPE_ID,
        log: silentLog,
      });
      expect((await handler(new Request(asset.mediaUrl))).status).toBe(403);
    }
  );
});

describe('parseSingleByteRange', () => {
  const totalSize = 1000;

  it('parses valid start-end ranges', () => {
    expect(parseSingleByteRange('bytes=0-499', totalSize)).toEqual({ start: 0, end: 499 });
    expect(parseSingleByteRange('bytes=500-999', totalSize)).toEqual({ start: 500, end: 999 });
    expect(parseSingleByteRange('bytes=0-0', totalSize)).toEqual({ start: 0, end: 0 });
  });

  it('parses open-ended suffix and prefix ranges', () => {
    expect(parseSingleByteRange('bytes=500-', totalSize)).toEqual({ start: 500, end: 999 });
    expect(parseSingleByteRange('bytes=-200', totalSize)).toEqual({ start: 800, end: 999 });
  });

  it('clamps end to totalSize - 1', () => {
    expect(parseSingleByteRange('bytes=0-2000', totalSize)).toEqual({ start: 0, end: 999 });
  });

  it('returns invalid for malformed or out-of-bounds ranges', () => {
    expect(parseSingleByteRange('bytes=500-200', totalSize)).toBe('invalid');
    expect(parseSingleByteRange('bytes=1000-', totalSize)).toBe('invalid');
    expect(parseSingleByteRange('bytes=-0', totalSize)).toBe('invalid');
    expect(parseSingleByteRange('bytes=0-499,500-999', totalSize)).toBe('invalid'); // multi-range
    expect(parseSingleByteRange('not-bytes=0-100', totalSize)).toBe('invalid');
    expect(parseSingleByteRange('bytes=-', totalSize)).toBe('invalid');
  });

  it('returns null when range header is absent or empty', () => {
    expect(parseSingleByteRange(null, totalSize)).toBeNull();
    expect(parseSingleByteRange(undefined, totalSize)).toBeNull();
    expect(parseSingleByteRange('', totalSize)).toBeNull();
  });
});

describe('extractAssetIdFromUrl', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('extracts asset ID from standard media URLs', () => {
    expect(extractAssetIdFromUrl(`interleaf-media://${validUuid}`)).toBe(validUuid);
    expect(extractAssetIdFromUrl(`interleaf-media:///${validUuid}`)).toBe(validUuid);
    expect(extractAssetIdFromUrl(`interleaf-media://asset/${validUuid}`)).toBe(validUuid);
  });

  it('rejects foreign schemes and path traversal attempts', () => {
    expect(extractAssetIdFromUrl('http://localhost/asset')).toBeNull();
    expect(extractAssetIdFromUrl('file:///etc/passwd')).toBeNull();
    expect(extractAssetIdFromUrl('interleaf-media:///../../etc/passwd')).toBeNull();
    expect(extractAssetIdFromUrl('interleaf-media:///asset/../etc/passwd')).toBeNull();
    expect(extractAssetIdFromUrl('interleaf-media:///asset.with.dots')).toBeNull();
    expect(extractAssetIdFromUrl('interleaf-media:///')).toBeNull();
    expect(extractAssetIdFromUrl('invalid-url')).toBeNull();
  });

  it('rejects query-polluted, credentialed, and multi-segment URLs', () => {
    expect(extractAssetIdFromUrl(`interleaf-media://${validUuid}?token=secret`)).toBeNull();
    expect(extractAssetIdFromUrl(`interleaf-media://${validUuid}#fragment`)).toBeNull();
    expect(extractAssetIdFromUrl(`interleaf-media://user:pass@${validUuid}`)).toBeNull();
    expect(extractAssetIdFromUrl(`interleaf-media://${validUuid}/extra/segment`)).toBeNull();
    expect(extractAssetIdFromUrl(`interleaf-media://../${validUuid}`)).toBeNull();
  });
});
