/**
 * Single entry point for pdfjs-dist's viewer-level components.
 *
 * The bare import below must stay first: it installs `globalThis.pdfjsLib`,
 * which `web/pdf_viewer.mjs` destructures while it evaluates. See
 * `pdf-viewer-globals.ts` for the full explanation.
 */
import './pdf-viewer-globals';

export { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs';

import type { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { PageViewport } from 'pdfjs-dist';
import type { getTextContentParameters } from 'pdfjs-dist/types/src/display/api';

/**
 * The text layer's render contract as the implementation actually honours it.
 *
 * `images` is optional at runtime — PDF.js guards on it and upstream's own
 * `PDFPageView` passes null when a page has no image coordinates — but the
 * generated declaration marks it required, which would force every caller to
 * fabricate an unused `TextLayerImages`. The builder is re-typed once here
 * instead.
 */
export type TextLayerRenderer = {
  render(options: {
    readonly viewport: PageViewport;
    readonly textContentParams?: getTextContentParameters;
  }): Promise<void>;
};

export function textLayerRenderer(builder: TextLayerBuilder): TextLayerRenderer {
  return builder as TextLayerRenderer;
}
