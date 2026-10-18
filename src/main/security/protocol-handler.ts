import { protocol } from 'electron';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Logger } from '../logging/logger';
import type { AssetRegistry } from './asset-registry';
import { isStrictlyInside } from './path-guard';

export type ParsedByteRange = {
  readonly start: number;
  readonly end: number;
};

export function parseSingleByteRange(
  rangeHeader: string | null | undefined,
  totalSize: number
): ParsedByteRange | 'invalid' | null {
  if (rangeHeader === null || rangeHeader === undefined || rangeHeader.trim().length === 0) {
    return null;
  }
  if (!Number.isSafeInteger(totalSize) || totalSize < 0 || rangeHeader.length > 128) {
    return 'invalid';
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (match === null) {
    return 'invalid';
  }
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') {
    return 'invalid';
  }

  let start: number;
  let end: number;
  if (startText !== '') {
    start = Number(startText);
    end = endText === '' ? totalSize - 1 : Number(endText);
  } else {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

export function extractAssetIdFromUrl(rawUrl: string): string | null {
  if (rawUrl.length === 0 || rawUrl.length > 256) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== 'interleaf-media:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    let candidate: string;
    if (parsed.hostname !== '' && parsed.hostname !== 'asset') {
      if (segments.length !== 0) {
        return null;
      }
      candidate = parsed.hostname;
    } else {
      if (segments.length !== 1) {
        return null;
      }
      candidate = segments[0] ?? '';
    }
    return /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export type MediaProtocolHandlerDependencies = {
  readonly assetRegistry: AssetRegistry;
  readonly currentScopeId: () => string;
  readonly log: Logger;
  /** Test/diagnostic hooks never exposed across IPC. */
  readonly onNodeStreamCreated?: (stream: Readable) => void;
  readonly onNodeStreamClosed?: () => void;
};

/** Injectable protocol seam used by Electron registration and real-stream tests. */
export function createMediaProtocolHandler(
  dependencies: MediaProtocolHandlerDependencies
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const assetId = extractAssetIdFromUrl(request.url);
    if (assetId === null) {
      dependencies.log.warn('blocked malformed interleaf-media request');
      return new Response('Bad Request', { status: 400 });
    }
    const asset = dependencies.assetRegistry.resolveAsset(assetId, dependencies.currentScopeId());
    if (asset === null) {
      dependencies.log.info('media asset unavailable');
      return new Response('Not Found', { status: 404 });
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const [root, candidate] = await Promise.all([
        realpath(asset.permittedRoot),
        realpath(asset.canonicalPath),
      ]);
      if (!isStrictlyInside(root, candidate)) {
        dependencies.log.warn('blocked media asset outside permitted root');
        return new Response('Forbidden', { status: 403 });
      }

      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      handle = await open(candidate, constants.O_RDONLY | noFollow);
      const [opened, currentPath, current, leaf] = await Promise.all([
        handle.stat(),
        realpath(candidate),
        stat(candidate),
        lstat(candidate),
      ]);
      if (
        !opened.isFile() ||
        leaf.isSymbolicLink() ||
        !isStrictlyInside(root, currentPath) ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) {
        await handle.close();
        handle = undefined;
        dependencies.log.warn('blocked media asset identity mismatch');
        return new Response('Forbidden', { status: 403 });
      }

      const totalSize = opened.size;
      const range = parseSingleByteRange(request.headers.get('range'), totalSize);
      if (range === 'invalid') {
        await handle.close();
        handle = undefined;
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${String(totalSize)}`, 'Accept-Ranges': 'bytes' },
        });
      }

      const partial = range !== null;
      const start = partial ? range.start : 0;
      const end = partial ? range.end : Math.max(0, totalSize - 1);
      const contentLength = totalSize === 0 ? 0 : end - start + 1;
      const responseHeaders: Record<string, string> = {
        'Content-Type': asset.mimeType,
        'Content-Length': String(contentLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (partial) {
        responseHeaders['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(totalSize)}`;
      }

      if (request.method === 'HEAD' || totalSize === 0) {
        await handle.close();
        handle = undefined;
        return new Response(null, { status: partial ? 206 : 200, headers: responseHeaders });
      }

      const nodeStream = handle.createReadStream({ start, end, highWaterMark: 64 * 1024 });
      dependencies.onNodeStreamCreated?.(nodeStream);
      const abort = (): void => {
        nodeStream.destroy(new Error('Request aborted'));
      };
      request.signal.addEventListener('abort', abort, { once: true });
      nodeStream.once('close', () => {
        request.signal.removeEventListener('abort', abort);
        dependencies.onNodeStreamClosed?.();
      });
      // Node's adapter propagates pull/cancel backpressure to the ReadStream.
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      handle = undefined; // The read stream owns and closes the FileHandle.
      return new Response(body, { status: partial ? 206 : 200, headers: responseHeaders });
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      dependencies.log.warn('media asset stream failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return new Response('Not Found', { status: 404 });
    }
  };
}

export function registerMediaProtocol(
  assetRegistry: AssetRegistry,
  currentScopeId: () => string,
  log: Logger
): void {
  protocol.handle(
    'interleaf-media',
    createMediaProtocolHandler({ assetRegistry, currentScopeId, log })
  );
}
