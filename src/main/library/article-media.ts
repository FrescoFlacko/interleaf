import { createHash } from 'node:crypto';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import { MAX_MEDIA_BYTES } from '../net/web-media-fetcher';
import type { WebMediaTransport } from '../net/web-media-transport';
import { MAX_ARTICLE_IMAGES } from './article-content';
import { startMediaPhaseClock } from './media-phase-clock';

/**
 * Archives the images an article snapshot wants to show.
 *
 * This is the bounded middle of the media path: extraction decided *which*
 * URLs are worth keeping, the transport decides whether any individual
 * response is an admissible raster, and this decides how many of them, how
 * large in total, how many at once, and for how long. Nothing here parses or
 * decodes image content.
 *
 * It holds admitted bytes in memory and returns them rather than writing
 * files, which keeps the untrusted half of an import free of filesystem and
 * database effects: an import that fails at any point leaves nothing behind,
 * and storage only becomes involved once a complete snapshot exists. The
 * aggregate cap is what makes that affordable.
 *
 * A single bad image is not an article-level failure. A picture that is
 * unreachable, mislabelled, oversized, or simply not a raster is dropped and
 * its alt text and caption still render. The phase deadline behaves the same
 * way: running out of time means the remaining pictures are omissions, not that
 * the article is lost, because a readable snapshot missing four figures is
 * plainly better than no snapshot at all. Security violations and explicit
 * cancellation are different in kind — they say something about the request
 * rather than about one picture — so those stop the whole import, matching the
 * policy the page fetcher already applies.
 */

/**
 * Images archived per article, independent of how many the page offers.
 *
 * This is deliberately the *same* number the extraction IR already validates
 * against rather than a second, smaller one. Two independent limits silently
 * disagreed: extraction admitted up to 40 image blocks and the archive then
 * requested the first 12, so an illustrated article lost two thirds of its
 * figures with nothing failing anywhere. Deriving the bound here means the
 * snapshot can ask for every image it is allowed to describe, and a future
 * change to the IR bound moves both together. The byte, time, and concurrency
 * budgets below are what actually keep an import affordable; this is a shape
 * bound, not a cost bound.
 */
export const MAX_ARCHIVED_IMAGES = MAX_ARTICLE_IMAGES;
/** Aggregate wire budget for one article's images. */
export const MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
/** Simultaneous image requests to one article's hosts. */
const MEDIA_FETCH_CONCURRENCY = 3;
/** Wall-clock ceiling for the whole image phase of an import. */
export const MEDIA_PHASE_TIMEOUT_MS = 30_000;

export type ArticleMediaAsset = {
  /** Durable reference written into the snapshot, `interleaf-asset:<sha256><ext>`. */
  readonly reference: string;
  readonly hash: string;
  readonly extension: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
};

/**
 * What one article's image phase did, and what it did not do.
 *
 * `archived` and `omitted` are the reader-visible partition, and they partition
 * the candidate list exactly: `archived + omitted === candidates` for every
 * outcome that returns at all. Every candidate is either shown or described in
 * words; there is no third state. `requested` is an *operational* metric that
 * overlaps both — a candidate that was asked for and failed is counted in both
 * `requested` and `omitted` — and no count is ever adjusted to make some other
 * equation come out even.
 *
 * - `archived` — candidate references the snapshot will show. Counted per
 *   candidate, not per stored file: two URLs holding identical bytes are two
 *   archived candidates behind one file on disk, and neither is an omission.
 * - `omitted` — candidates the snapshot will describe in words rather than
 *   show. That is one of five things, all of them equally an omission from the
 *   reader's side: dropped by the extraction ceiling before the phase began,
 *   truncated by the count cap before any request, skipped because the
 *   aggregate byte budget was already spent, requested and failed (unreachable,
 *   mislabelled, oversized, not an admissible still), or left unfetched when
 *   the phase deadline passed.
 * - `requested` — transport calls actually started. Nothing is counted here
 *   that was never asked for, and it is not part of the partition.
 *
 * The counts are deterministic given the same candidates, responses, and
 * bounds — they never depend on which lane finished first. A cancellation or an
 * address-policy violation throws instead of returning, because those describe
 * the request rather than one picture.
 */
export type CollectedArticleMedia = {
  /** Page image URL to durable reference, for the images that were archived. */
  readonly references: ReadonlyMap<string, string>;
  /** One entry per distinct content hash, in reading order. */
  readonly assets: readonly ArticleMediaAsset[];
  readonly archived: number;
  readonly requested: number;
  readonly omitted: number;
};

export type ArticleMediaOptions = {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly maxImages?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
};

export type ArticleMediaDeps = {
  readonly transport: WebMediaTransport;
  readonly log: Logger;
};

/** Builds the durable identity for admitted bytes. */
export function assetReference(hash: string, extension: string): string {
  return `interleaf-asset:${hash}${extension}`;
}

/**
 * True for failures that must end the import rather than drop one image.
 *
 * An address-policy rejection means the page pointed Interleaf somewhere it is
 * not allowed to go. Silently continuing would turn a blocked request into a
 * routine omission and hide a probe, so it is fatal exactly as it is when the
 * page itself resolves to a forbidden address.
 */
function isFatalMediaError(caught: Error | null): caught is InterleafError {
  return caught instanceof InterleafError && caught.code === 'security-violation';
}

/** The code one skipped image is logged under. */
function mediaFailureCode(caught: Error | null): string {
  return caught instanceof InterleafError ? caught.code : 'unknown';
}

function cancelled(): InterleafError {
  return new InterleafError('validation', 'That import was cancelled.');
}

/**
 * The first import-ending failure any lane saw.
 *
 * Lanes record it from inside a closure and the caller reads it after they
 * join, so holding it behind methods keeps the declared type intact where a
 * captured local would read as permanently unset. Only the first failure is
 * kept: later lanes unwinding from the same cancellation should not replace the
 * reason the import actually stopped.
 */
class FatalFailure {
  private error: InterleafError | null = null;

  record(error: InterleafError): void {
    this.error ??= error;
  }

  wasRecorded(): boolean {
    return this.error !== null;
  }

  rethrow(): void {
    const error = this.error;
    if (error !== null) throw error;
  }
}

/**
 * Tracks the shared byte budget.
 *
 * Each request reserves the smaller of the per-image cap and what is left, so
 * concurrent downloads can never overshoot the aggregate even before any of
 * them finishes; the unspent part of a reservation returns once the transport
 * reports what the request actually moved.
 */
class MediaBudget {
  private remaining: number;

  constructor(total: number) {
    this.remaining = total;
  }

  reserve(): number {
    const share = Math.max(0, Math.min(MAX_MEDIA_BYTES, this.remaining));
    this.remaining -= share;
    return share;
  }

  refund(amount: number): void {
    this.remaining += Math.max(0, amount);
  }
}

/**
 * What one image actually moved on the wire or stored in library storage.
 *
 * The transport reports through this whether the fetch succeeded, was refused
 * for being oversized, or died mid-body. A call that reports nothing is treated
 * as having spent its entire reservation, so a failure is never free: without
 * that, twelve rejected 8 MB responses would transfer 96 MB while each refunded
 * its reservation in full behind a 24 MB aggregate cap. Stored bytes are also
 * accounted so canonical re-encoding inflation is charged against the budget.
 */
class MediaSpend {
  private wire: number | null = null;
  private stored = 0;

  recordWire(bytes: number): void {
    this.wire = Math.max(this.wire ?? 0, bytes);
  }

  recordStored(bytes: number): void {
    this.stored = Math.max(this.stored, bytes);
  }

  /** Bytes to charge, using the greater of wire bytes and stored canonical bytes. */
  charged(reserved: number): number {
    const effectiveWire = this.wire ?? reserved;
    return Math.max(effectiveWire, this.stored);
  }
}

async function fetchOne(
  url: string,
  reserved: number,
  spend: MediaSpend,
  deps: ArticleMediaDeps,
  options: ArticleMediaOptions,
  signal: AbortSignal
): Promise<ArticleMediaAsset> {
  const media = await deps.transport.fetchImage(url, {
    signal,
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    maxTransferBytes: reserved,
    onWireBytes: (bytes) => {
      spend.recordWire(bytes);
    },
  });
  // A transport that reports nothing on success still spent at least the bytes
  // it handed back, so the aggregate cap holds either way.
  spend.recordStored(media.bytes.byteLength);
  const hash = createHash('sha256').update(media.bytes).digest('hex');
  return {
    reference: assetReference(hash, media.extension),
    hash,
    extension: media.extension,
    mimeType: media.mimeType,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
  };
}

/**
 * Fetches and admits the article's images under fixed bounds.
 *
 * Results are assembled in the order the sources were given rather than the
 * order responses arrived, so the snapshot bytes for a given page do not depend
 * on network timing.
 */
export async function collectArticleMedia(
  sources: readonly string[],
  deps: ArticleMediaDeps,
  options: ArticleMediaOptions = {}
): Promise<CollectedArticleMedia> {
  const maxImages = Math.min(options.maxImages ?? MAX_ARCHIVED_IMAGES, MAX_ARCHIVED_IMAGES);
  const admitted = sources.slice(0, maxImages);
  // Candidates the count cap removed before anything was asked for. They are
  // omissions in exactly the sense the reader experiences — a picture the page
  // had and the snapshot will not show — so they are reported as such rather
  // than disappearing between the extractor and the log line.
  const capTruncated = sources.length - admitted.length;
  if (admitted.length === 0) {
    return { references: new Map(), assets: [], archived: 0, requested: 0, omitted: capTruncated };
  }
  const isCancelled = (): boolean => options.signal?.aborted === true;
  if (isCancelled()) throw cancelled();

  const budget = new MediaBudget(
    Math.min(options.maxTotalBytes ?? MAX_TOTAL_MEDIA_BYTES, MAX_TOTAL_MEDIA_BYTES)
  );
  const results = new Array<ArticleMediaAsset | null>(admitted.length).fill(null);
  const lanes = Math.max(1, Math.min(options.concurrency ?? MEDIA_FETCH_CONCURRENCY, admitted.length));
  // One array iterator shared by every lane hands each lane the next candidate:
  // its steps are indivisible here, and an array iterator cannot be closed by a
  // lane that leaves the loop early, so no candidate is skipped or repeated.
  const queue = admitted.entries();
  let requested = 0;
  let omitted = capTruncated;
  const fatal = new FatalFailure();

  // This phase owns its own signal rather than borrowing the import's, so its
  // deadline can end image work without reaching back into the page fetch.
  const clock = startMediaPhaseClock(options.signal, options.deadline);

  const runLane = async (): Promise<void> => {
    for (const [index, url] of queue) {
      if (fatal.wasRecorded()) return;
      if (isCancelled()) {
        fatal.record(cancelled());
        return;
      }
      // Out of time: drain the rest of the queue as omissions instead of
      // throwing, so the article arrives partially illustrated and every
      // picture it will not show is counted.
      if (clock.expired()) {
        omitted += 1;
        continue;
      }
      const reserved = budget.reserve();
      if (reserved === 0) {
        omitted += 1;
        continue;
      }
      const spend = new MediaSpend();
      requested += 1;
      try {
        results[index] = await fetchOne(url, reserved, spend, deps, options, clock.signal);
      } catch (error) {
        const caught = error instanceof Error ? error : null;
        if (isFatalMediaError(caught)) {
          fatal.record(caught);
          return;
        }
        // A request that failed because the import was cancelled reports the
        // cancellation, not whatever the socket happened to say on the way down.
        if (isCancelled()) {
          fatal.record(cancelled());
          return;
        }
        omitted += 1;
        deps.log.info('Skipped an article image', { reason: mediaFailureCode(caught) });
      } finally {
        // Return only what this request did not move or store.
        budget.refund(Math.max(0, reserved - spend.charged(reserved)));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: lanes }, runLane));
  } finally {
    clock.dispose();
  }
  fatal.rethrow();

  const references = new Map<string, string>();
  const assets: ArticleMediaAsset[] = [];
  const seenHashes = new Set<string>();
  let archived = 0;
  for (const [index, url] of admitted.entries()) {
    const asset = results[index];
    if (asset === undefined || asset === null) continue;
    archived += 1;
    references.set(url, asset.reference);
    // Same bytes behind a second URL: one stored file, two references.
    if (seenHashes.has(asset.hash)) continue;
    seenHashes.add(asset.hash);
    assets.push(asset);
  }

  return { references, assets, archived, requested, omitted };
}
