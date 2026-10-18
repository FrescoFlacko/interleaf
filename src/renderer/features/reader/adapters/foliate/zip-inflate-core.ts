import { unzipSync } from 'fflate';
import { isSafeArchivePath, ZIP_SAFETY_LIMITS } from './zip-loader-limits';

export type ZipInflateLimits = {
  readonly maxEntries: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxSingleEntryBytes: number;
};

export type InflatedZipEntry = {
  readonly filename: string;
  readonly bytes: Uint8Array;
};

/**
 * CPU-heavy ZIP inflation core. Production callers run this module only inside
 * zip-inflate.worker.ts; exporting it separately keeps the safety policy
 * directly unit-testable without weakening the renderer boundary.
 */
export function inflateZipArchive(
  bytes: Uint8Array,
  limits: ZipInflateLimits = ZIP_SAFETY_LIMITS
): InflatedZipEntry[] {
  let discoveredEntries = 0;
  let declaredTotalBytes = 0;
  const discoveredNames = new Set<string>();
  let unzipped: Record<string, Uint8Array>;

  try {
    unzipped = unzipSync(bytes, {
      filter: (entry) => {
        discoveredEntries += 1;
        if (discoveredEntries > limits.maxEntries) {
          throw new Error('Archive exceeds the maximum entry count');
        }
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new Error('Archive contains an invalid entry size');
        }
        if (entry.originalSize > limits.maxSingleEntryBytes) {
          throw new Error('Archive entry exceeds the maximum uncompressed size');
        }
        declaredTotalBytes += entry.originalSize;
        if (declaredTotalBytes > limits.maxTotalUncompressedBytes) {
          throw new Error('Archive exceeds the maximum total uncompressed size');
        }
        if (!isSafeArchivePath(entry.name)) {
          throw new Error('Archive contains an unsafe entry path');
        }
        if (discoveredNames.has(entry.name)) {
          throw new Error('Archive contains a duplicate entry path');
        }
        discoveredNames.add(entry.name);
        return !entry.name.endsWith('/');
      },
    });
  } catch (error) {
    throw new Error(`Failed to unzip archive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const filenames = Object.keys(unzipped);
  if (filenames.length > limits.maxEntries) {
    throw new Error('Archive exceeds the maximum entry count');
  }

  let totalBytes = 0;
  return filenames.map((filename) => {
    const entryData = unzipped[filename];
    if (!entryData || !isSafeArchivePath(filename)) {
      throw new Error('Archive contains an invalid entry');
    }
    if (entryData.byteLength > limits.maxSingleEntryBytes) {
      throw new Error('Archive entry exceeds the maximum uncompressed size');
    }
    totalBytes += entryData.byteLength;
    if (totalBytes > limits.maxTotalUncompressedBytes) {
      throw new Error('Archive exceeds the maximum total uncompressed size');
    }
    return { filename, bytes: entryData };
  });
}
