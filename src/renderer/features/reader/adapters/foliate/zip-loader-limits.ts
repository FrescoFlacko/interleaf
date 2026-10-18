export const ZIP_SAFETY_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxSingleEntryBytes: 128 * 1024 * 1024,
});

/** Validates an archive entry path before it can enter the in-memory book. */
export function isSafeArchivePath(path: string): boolean {
  if (!path || path.trim().length === 0) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    return false;
  }
  const segments = normalized.split('/');
  return segments.every((segment) => segment !== '..' && segment !== '.');
}
