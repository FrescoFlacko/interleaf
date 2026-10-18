/**
 * The contract between the web-article import path and whatever actually
 * performs a network fetch.
 *
 * The import path depends only on this type, so tests can supply a fixture
 * transport and never touch a real host, while the production transport
 * remains the only code that owns DNS, sockets, redirects, and bounds.
 */
export type FetchedWebPage = {
  /** Decoded HTML source. Untrusted; must be parsed off the main thread. */
  readonly html: string;
  /** Final URL after redirects, already stripped of credentials and fragment. */
  readonly finalUrl: string;
  /** Bytes received on the wire, for logging and bound accounting. */
  readonly transferredBytes: number;
};

export type WebArticleTransportOptions = {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly timeoutMs?: number;
};

export type WebArticleTransport = {
  fetchArticleHtml(url: string, options?: WebArticleTransportOptions): Promise<FetchedWebPage>;
};
