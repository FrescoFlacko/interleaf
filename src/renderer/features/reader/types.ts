import type {
  ChatSelectionDescriptor,
  DocumentFormat,
  DocumentMediaAsset,
  DocumentLocation,
  NormalizedTextChunk,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
import type { Annotation, AnnotationAnchorScope, DocumentAnchor } from '@shared/types/annotation';
import type { SearchMatchAnchor } from '@shared/types/search';

export type DocumentSource = {
  readonly documentId: string;
  /** Main-owned revision bound used by transient search paint. */
  readonly documentHash: string;
  readonly assetUrl: string;
  /**
   * Capabilities for the document's archived images, keyed by the durable
   * reference that appears inside the content. Empty for formats that carry
   * their images inside the file itself.
   */
  readonly mediaAssets: readonly DocumentMediaAsset[];
  readonly initialLocation: DocumentLocation | null;
};

/** What the search panel asks the reader to paint. */
export type SearchHighlightInput = {
  readonly documentId: string;
  readonly documentHash: string;
  readonly query: string;
  readonly location: DocumentLocation;
  readonly anchor: SearchMatchAnchor;
};

/** A search paint the reader store has accepted and numbered, waiting for the mounted reader. */
export type PendingSearchHighlight = SearchHighlightInput & {
  readonly requestId: number;
};

/** A pending paint handed to the adapter, cancelled when the reader moves on. */
export type SearchHighlightRequest = PendingSearchHighlight & {
  readonly signal: AbortSignal;
};

/**
 * Whether the reader moved on from this paint. Adapters ask after every await;
 * reading through a call keeps the check live where a repeated property read
 * would look already settled to the type checker.
 */
export function isSearchHighlightCancelled(request: SearchHighlightRequest): boolean {
  return request.signal.aborted;
}

export type SearchHighlightResult = {
  readonly status: 'applied' | 'not-found' | 'unsupported' | 'stale';
  readonly text: string | null;
  readonly rangeCount: number;
};

export type ReflowOptions = {
  readonly lineHeight: number;
  readonly horizontalMarginRem: number;
  readonly fontSize: number;
  readonly fontFamily: 'system' | 'serif' | 'sans' | 'dyslexic';
  readonly contentWidth: number;
  readonly paragraphSpacing: number;
};
export type SelectionIssue =
  | {
      readonly code: 'size_limit';
      readonly message: string;
      readonly maxLength: number;
    }
  | {
      readonly code: 'span_limit';
      readonly message: string;
      readonly unit: 'pages' | 'paragraphs' | 'blocks' | 'sections' | 'segments';
      readonly maxSpan: number;
    }
  | {
      readonly code: 'mapping_failure';
      readonly message: string;
    }
  | {
      readonly code: 'stale_layer';
      readonly message: string;
    }
  | {
      readonly code: 'unsupported';
      readonly message: string;
    };

export function selectionIssueHeading(issue: SelectionIssue): string {
  switch (issue.code) {
    case 'size_limit':
    case 'span_limit':
      return 'Selection limit exceeded:';
    case 'mapping_failure':
      return 'Selection mapping failed:';
    case 'stale_layer':
      return 'Selection interrupted:';
    case 'unsupported':
      return 'Selection unsupported:';
  }
}

export type ReaderSelection = {
  readonly selectedText: string;
  readonly totalSelectedLength: number;
  readonly chatDescriptor: ChatSelectionDescriptor;
  readonly anchor: DocumentAnchor | null;
  /** Viewport coordinates in the top-level renderer window. */
  readonly clientRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
};
export type AnnotationAnchorResolution = {
  readonly annotationId: string;
  readonly status: 'anchored' | 'unanchored';
  readonly anchor: DocumentAnchor;
  readonly stage: 'native' | 'quote' | 'fuzzy' | 'unanchored';
};

type LocationChangeCallback = (location: DocumentLocation, progress: number) => void;

/** `issue` explains a cleared selection that could not be captured; it is `null` otherwise. */
export type SelectionChangeCallback = (selection: ReaderSelection | null, issue: SelectionIssue | null) => void;

export type AnnotationResolutionCallback = (result: AnnotationAnchorResolution) => void;

export type ExternalLinkCallback = (url: string) => void | Promise<void>;

/** Reflowable formats re-typeset their text; fixed-layout formats have no such control. */
type ReflowCapability = {
  /** Apply reflow typography. */
  setReflowOptions(options: ReflowOptions): Promise<void>;
};

/** Formats whose content carries followable links out of the document. */
type ExternalLinkCapability = {
  /**
   * Receive links the reader followed out of the document. The adapter reports
   * the target and does nothing else with it: only main can decide whether a
   * link leaves the application, so an adapter with no callback set leaves
   * every external link inert. Internal anchors are the adapter's own business
   * and are never reported here.
   */
  setExternalLinkCallback(callback: ExternalLinkCallback | null): void;
};

export type DocumentAdapterCapabilities = {
  readonly reflow: ReflowCapability | null;
  readonly externalLinks: ExternalLinkCapability | null;
};

export type DocumentAdapter = {
  readonly format: DocumentFormat;

  /** Initialize from an opaque, main-authorized asset source and render container. */
  open(containerElement: HTMLElement, source: DocumentSource): Promise<void>;

  /** Teardown DOM nodes, active tasks, listeners, and worker instances. */
  close(): Promise<void>;

  /** Extract table of contents outline if available. */
  getTableOfContents(): Promise<readonly TableOfContentsItem[]>;

  /** Navigate to a specific document location. */
  goToLocation(location: DocumentLocation): Promise<void>;

  /** Retrieve current visible viewport reading location and percentage progress. */
  getReadingLocation(): { readonly location: DocumentLocation; readonly progress: number };

  /** Retrieve reading progress from 0.0 to 1.0. */
  getProgress(): number;

  /** Search text within the active document. */
  search(query: string): Promise<readonly SearchMatch[]>;

  /** Paint one bounded, transient search range in the native reader surface. */
  applySearchHighlight(request: SearchHighlightRequest): Promise<SearchHighlightResult>;

  /** Remove only the transient search highlight; persisted annotation ranges remain. */
  clearSearchHighlight(): void;

  /** Stream normalized text chunks across the document for indexing. */
  extractText(): AsyncIterable<NormalizedTextChunk>;

  /** Extract text content for a specific location. */
  extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]>;

  /** Set zoom level: percentage scale number (e.g. 1.0, 1.5) or fit mode. */
  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void>;

  /** Get numeric zoom scale. */
  getZoom(): number;

  /** Get active zoom mode. */
  getZoomMode(): ZoomMode;

  /** Total page count. */
  getPageCount(): number;

  /** 1-based current page number. */
  getCurrentPage(): number;

  /** Navigate to a specific 1-based page number. */
  goToPage(pageNumber: number): Promise<void>;

  /** Report the visible reading location after each scroll or navigation; `null` stops reporting. */
  setLocationChangeCallback(callback: LocationChangeCallback | null): void;

  /** Subscribe to format-native text selections; `null` stops reporting. */
  setSelectionChangeCallback(callback: SelectionChangeCallback | null): void;

  /** Receive eventual resolution results as virtualized pages/sections mount; `null` stops reporting. */
  setAnnotationResolutionCallback(callback: AnnotationResolutionCallback | null): void;

  /** Re-resolve and paint persisted annotations after render/zoom/reflow. */
  setAnnotations(annotations: readonly Annotation[]): Promise<readonly AnnotationAnchorResolution[]>;

  /** Navigate to an annotation's exact anchor when possible. */
  goToAnnotation(annotation: Annotation): Promise<void>;

  /**
   * Describe the mounted/overscan region whose annotations should be painted;
   * `null` until the document has rendered a region.
   */
  getAnnotationScope(): AnnotationAnchorScope | null;

  /** What this format can do beyond the common contract; `null` means unsupported. */
  readonly capabilities: DocumentAdapterCapabilities;
};
