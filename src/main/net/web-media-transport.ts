/**
 * The seam between article import and the network for images.
 *
 * Import depends on this interface rather than on the concrete fetcher so the
 * automated suites can supply deterministic bytes without ever opening a
 * socket, exactly as `WebArticleTransport` does for page HTML.
 */

export type FetchedWebMedia = {
  readonly bytes: Buffer;
  /** Canonical type decided by the magic bytes, not by the response header. */
  readonly mimeType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  /** Post-redirect URL, validated and credential-free. */
  readonly finalUrl: string;
};

export type WebMediaTransportOptions = {
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline shared with the rest of the import. */
  readonly deadline?: number;
  readonly timeoutMs?: number;
  /** Per-image wire cap, tightened by the caller's remaining aggregate budget. */
  readonly maxTransferBytes?: number;
  /**
   * Reports the bytes this call actually moved, success or failure.
   *
   * A caller spending from a shared allowance uses this to return only the
   * genuinely unused part of a reservation. An implementation that reports
   * nothing forfeits the whole reservation for a failed call, so a transport
   * cannot make repeated failures free by staying quiet about them.
   */
  readonly onWireBytes?: (bytes: number) => void;
};

export type WebMediaTransport = {
  fetchImage(url: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia>;
};
