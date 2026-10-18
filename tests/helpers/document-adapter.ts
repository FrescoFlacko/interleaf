import type { DocumentFormat } from '../../src/shared/types/document';
import type {
  DocumentAdapter,
  DocumentAdapterCapabilities,
} from '../../src/renderer/features/reader/types';

/**
 * A complete reader adapter double for one document format.
 *
 * The reader store holds one adapter and the UI calls it directly, so a
 * component test has to seat something there. This builds the whole required
 * contract: every member is present and typed, and a test replaces only the
 * calls its own case exercises. A call the test did not stub throws and names
 * itself.
 *
 * The format decides the capabilities, exactly as the real adapters do: PDF
 * reports external links but cannot reflow, Markdown does both, and the
 * Office and ebook formats reflow without reporting links. A test cannot hand
 * a format a capability its real adapter lacks, or take one away: stubs are
 * typed by format, so stubbing a call the format does not have fails to compile.
 *
 * `setAnnotations` resolves no anchors unless stubbed, as a real adapter does
 * before anything has rendered, because the store awaits it after every load.
 */

type ReflowCalls = NonNullable<DocumentAdapterCapabilities['reflow']>;
type ExternalLinkCalls = NonNullable<DocumentAdapterCapabilities['externalLinks']>;
type CapabilityCalls = ReflowCalls & ExternalLinkCalls;

/** The capability calls each format's real adapter exposes, and so the only ones a test may stub. */
type FormatCapabilityCalls = {
  readonly pdf: ExternalLinkCalls;
  readonly markdown: ReflowCalls & ExternalLinkCalls;
  readonly docx: ReflowCalls;
  readonly pptx: ReflowCalls;
  readonly epub: ReflowCalls;
  readonly mobi: ReflowCalls;
};

/** Replacements for the calls behind a capability the format really has. */
export type CapabilityStubs<F extends DocumentFormat = DocumentFormat> = Partial<FormatCapabilityCalls[F]>;

/** The members a test may replace; the format and its capabilities are fixed. */
export type AdapterOverrides = Partial<Omit<DocumentAdapter, 'format' | 'capabilities'>>;

/** What the reader gets back when it applies reflow typography or sets the link callback on mount. */
const PRODUCTION_CAPABILITY_CALLS: CapabilityCalls = {
  setReflowOptions: () => Promise.resolve(),
  setExternalLinkCallback: () => undefined,
};

const reflowOnly = (calls: CapabilityCalls): DocumentAdapterCapabilities => ({
  reflow: { setReflowOptions: calls.setReflowOptions },
  externalLinks: null,
});

const FORMAT_CAPABILITIES: Record<DocumentFormat, (calls: CapabilityCalls) => DocumentAdapterCapabilities> = {
  pdf: (calls) => ({
    reflow: null,
    externalLinks: { setExternalLinkCallback: calls.setExternalLinkCallback },
  }),
  markdown: (calls) => ({
    reflow: { setReflowOptions: calls.setReflowOptions },
    externalLinks: { setExternalLinkCallback: calls.setExternalLinkCallback },
  }),
  docx: reflowOnly,
  pptx: reflowOnly,
  epub: reflowOnly,
  mobi: reflowOnly,
};

function unstubbed(method: string): never {
  throw new Error(`The test did not stub adapter.${method}.`);
}

export function testDocumentAdapter<F extends DocumentFormat>(
  format: F,
  overrides: AdapterOverrides = {},
  capabilityStubs: CapabilityStubs<F> = {},
): DocumentAdapter {
  return {
    format,
    open: () => unstubbed('open'),
    close: () => unstubbed('close'),
    getTableOfContents: () => unstubbed('getTableOfContents'),
    goToLocation: () => unstubbed('goToLocation'),
    getReadingLocation: () => unstubbed('getReadingLocation'),
    getProgress: () => unstubbed('getProgress'),
    search: () => unstubbed('search'),
    applySearchHighlight: () => unstubbed('applySearchHighlight'),
    clearSearchHighlight: () => unstubbed('clearSearchHighlight'),
    extractText: () => unstubbed('extractText'),
    extractLocationText: () => unstubbed('extractLocationText'),
    setZoom: () => unstubbed('setZoom'),
    getZoom: () => unstubbed('getZoom'),
    getZoomMode: () => unstubbed('getZoomMode'),
    getPageCount: () => unstubbed('getPageCount'),
    getCurrentPage: () => unstubbed('getCurrentPage'),
    goToPage: () => unstubbed('goToPage'),
    setLocationChangeCallback: () => unstubbed('setLocationChangeCallback'),
    setSelectionChangeCallback: () => unstubbed('setSelectionChangeCallback'),
    setAnnotationResolutionCallback: () => unstubbed('setAnnotationResolutionCallback'),
    setAnnotations: () => Promise.resolve([]),
    goToAnnotation: () => unstubbed('goToAnnotation'),
    getAnnotationScope: () => unstubbed('getAnnotationScope'),
    ...overrides,
    capabilities: FORMAT_CAPABILITIES[format]({ ...PRODUCTION_CAPABILITY_CALLS, ...capabilityStubs }),
  };
}
