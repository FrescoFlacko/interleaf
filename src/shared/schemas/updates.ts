import { z } from 'zod';

/**
 * The application-update contract shared by main, preload and the renderer.
 *
 * The renderer only ever reads a projection of main's updater state and asks
 * for one of four fixed operations. No request carries a URL, a path, a token,
 * a version or a command: main alone decides where updates come from (the
 * pinned stable release destination), which file is downloaded and what is
 * installed. Release notes never cross the bridge, so no remote HTML or
 * Markdown is rendered; the release page is the truthful place to read them.
 */

const UPDATE_MESSAGE_MAX_LENGTH = 240;

/** A stable `major.minor.patch` version; pre-release and build suffixes are never offered. */
export const STABLE_VERSION_PATTERN = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;

const stableVersionSchema = z.string().max(24).regex(STABLE_VERSION_PATTERN);
/** The running build's own version, which may legitimately carry a suffix. */
const currentVersionSchema = z.string().min(1).max(64);
const timestampSchema = z.iso.datetime().max(40);
const messageSchema = z.string().min(1).max(UPDATE_MESSAGE_MAX_LENGTH);

/**
 * How this installation receives updates.
 *
 * - `self-update`: a signed macOS app or a Linux AppImage; Interleaf checks,
 *   downloads and installs its own update.
 * - `package-manager`: a deb or pacman install; the operating system owns the
 *   files, so Interleaf never replaces them and points at the release page.
 * - `development`: an unpackaged run; the feed is never contacted.
 * - `unsupported`: any other platform or install type; the feed is never contacted.
 */
const updateSupportSchema = z.enum(['self-update', 'package-manager', 'development', 'unsupported']);
export type UpdateSupport = z.infer<typeof updateSupportSchema>;

const updateErrorCodeSchema = z.enum([
  /** The release destination could not be reached. */
  'offline',
  /** The release metadata or a downloaded file failed authenticity or integrity checks. */
  'verification-failed',
  /** The build carries no pinned update-signing key, so nothing can be trusted. */
  'not-configured',
  'check-failed',
  'download-failed',
  'install-failed',
]);
export type UpdateErrorCode = z.infer<typeof updateErrorCodeSchema>;

/**
 * Download failures that may be retried against the same verified release. An
 * integrity failure is not among them: it needs a fresh check of the manifest.
 */
export const RETRYABLE_DOWNLOAD_ERRORS: ReadonlySet<UpdateErrorCode> = new Set(['download-failed', 'offline']);

const updatePhaseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }).strict(),
  z.object({ status: z.literal('checking') }).strict(),
  z.object({ status: z.literal('up-to-date'), latestVersion: stableVersionSchema }).strict(),
  /** The destination has no published stable release yet: distinct from "up to date". */
  z.object({ status: z.literal('no-release') }).strict(),
  z.object({ status: z.literal('available'), version: stableVersionSchema, releaseDate: timestampSchema }).strict(),
  z
    .object({
      status: z.literal('downloading'),
      version: stableVersionSchema,
      percent: z.number().min(0).max(100),
    })
    .strict(),
  z.object({ status: z.literal('downloaded'), version: stableVersionSchema }).strict(),
  z.object({ status: z.literal('installing'), version: stableVersionSchema }).strict(),
  z
    .object({
      status: z.literal('error'),
      code: updateErrorCodeSchema,
      message: messageSchema,
      /** The verified version whose download or install failed, when one was in hand. */
      version: stableVersionSchema.optional(),
    })
    .strict(),
]);
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;

export const updateStateSchema = z
  .object({
    currentVersion: currentVersionSchema,
    channel: z.literal('stable'),
    support: updateSupportSchema,
    /** Mirrors `settings.updates.automaticChecks`. */
    automaticChecks: z.boolean(),
    lastCheckedAt: timestampSchema.nullable(),
    phase: updatePhaseSchema,
  })
  .strict();
export type UpdateState = z.infer<typeof updateStateSchema>;

/** Work that an update restart would interrupt, counted by main. */
const activeWorkSummarySchema = z
  .object({
    agentSessions: z.number().int().nonnegative().max(10_000),
    chatStreams: z.number().int().nonnegative().max(10_000),
    imports: z.number().int().nonnegative().max(10_000),
  })
  .strict();
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

export const updateRestartResultSchema = z.discriminatedUnion('outcome', [
  /** Main accepted the restart and is draining the window and services before installing. */
  z.object({ outcome: z.literal('restarting'), version: stableVersionSchema }).strict(),
  /** Agent, chat or import work is still running; nothing was interrupted. */
  z.object({ outcome: z.literal('blocked'), activeWork: activeWorkSummarySchema }).strict(),
  /** No verified, fully downloaded update is ready, or a restart is already under way. */
  z.object({ outcome: z.literal('not-ready') }).strict(),
  /** The update could not be staged for installation; the app keeps running. */
  z.object({ outcome: z.literal('failed'), message: messageSchema }).strict(),
]);
export type UpdateRestartResult = z.infer<typeof updateRestartResultSchema>;

export const updateReleasePageResultSchema = z.object({ opened: z.boolean() }).strict();
export type UpdateReleasePageResult = z.infer<typeof updateReleasePageResultSchema>;
