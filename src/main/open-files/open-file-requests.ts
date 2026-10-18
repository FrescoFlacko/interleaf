import { extname, isAbsolute, resolve } from 'node:path';

/** Extensions the operating system may hand to Interleaf, compared case-insensitively. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.epub', '.mobi', '.azw', '.azw3', '.docx', '.pptx', '.md', '.markdown',
]);

/** Bounds an argv path before it reaches the filesystem; real validation happens on open. */
const MAX_REQUEST_PATH_LENGTH = 4096;

export function isOpenablePath(filePath: string): boolean {
  return filePath.length > 0 &&
    filePath.length <= MAX_REQUEST_PATH_LENGTH &&
    !filePath.includes('\0') &&
    OPENABLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * The document paths in a launch or second-instance command line. The
 * executable, switches (including Chromium's own), and anything without a
 * supported extension are ignored; a relative path resolves against the
 * directory the launch came from.
 */
export function openablePathsFromArgv(argv: readonly string[], workingDirectory: string): readonly string[] {
  return argv
    .slice(1)
    .filter((argument) => !argument.startsWith('-') && isOpenablePath(argument))
    .map((argument) => isAbsolute(argument) ? argument : resolve(workingDirectory, argument));
}

/**
 * Holds the most recent operating-system open request until the renderer asks
 * for it. Only the last path is kept, because opening a file replaces the one
 * before it. Requests that arrive before the application is ready (macOS
 * `open-file`, the launch command line) wait here; the renderer claims them
 * once it has mounted, and is nudged for any that arrive later.
 */
export class OpenFileRequestQueue {
  private pending: string | null = null;
  private notify: (() => void) | null = null;

  /** Records the last openable path; returns whether one was accepted. */
  enqueue(paths: readonly string[]): boolean {
    const accepted = paths.filter(isOpenablePath).at(-1);
    if (accepted === undefined) return false;
    this.pending = accepted;
    this.notify?.();
    return true;
  }

  /** Hands the pending path to exactly one caller. */
  take(): string | null {
    const next = this.pending;
    this.pending = null;
    return next;
  }

  /** Starts nudging the renderer; a request already waiting is announced at once. */
  attach(notify: () => void): void {
    this.notify = notify;
    if (this.pending !== null) notify();
  }
}
