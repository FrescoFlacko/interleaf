import { PeleError, render, type RenderOptions } from 'pele';
import {
  DIAGRAM_FONT_FAMILY,
  DIAGRAM_FONT_SIZE_PX,
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_SOURCE_CHARS,
  MAX_DIAGRAM_SVG_CHARS,
  sourceLimitFailure,
  type DiagramFailure,
  type DiagramRenderRequest,
  type DiagramRenderResponse,
} from './diagram-protocol';

/**
 * Render options are Interleaf's, never the source's: no links, no images, no
 * icon or math callbacks, and Pele's own size bounds. A `%%{init}%%` directive
 * in the source can still pick Pele config such as a theme or curve, but it
 * cannot reach any of these.
 */
function renderOptions(id: number): RenderOptions {
  return {
    fontFamily: DIAGRAM_FONT_FAMILY,
    fontSize: DIAGRAM_FONT_SIZE_PX,
    idPrefix: `ai-diagram-${String(id)}-`,
    padding: 8,
    limit: MAX_DIAGRAM_SOURCE_CHARS,
    outputLimit: MAX_DIAGRAM_SVG_CHARS,
    maxEdges: MAX_DIAGRAM_EDGES,
    links: false,
    images: false,
    linkSchemes: [],
    imageSchemes: [],
  };
}

function failureOf(error: PeleError): DiagramFailure {
  if (error.code === 'unsupported-diagram') return 'unsupported';
  if (error.code === 'limit') return 'too-large';
  return 'invalid';
}

/**
 * Renders one diagram source to SVG markup. Runs inside the diagram worker;
 * it is a separate module so the same bounds can be tested without a thread.
 * A failure reports only a category: Pele's messages quote the source, so they
 * never leave this function.
 */
export function renderDiagramSource(request: DiagramRenderRequest): DiagramRenderResponse {
  const { id, source } = request;
  const limited = sourceLimitFailure(source);
  if (limited !== null) return { id, ok: false, failure: limited };
  try {
    const result = render(source, renderOptions(id));
    if (result.svg.length > MAX_DIAGRAM_SVG_CHARS) return { id, ok: false, failure: 'too-large' };
    if (result.width > MAX_DIAGRAM_DIMENSION || result.height > MAX_DIAGRAM_DIMENSION) {
      return { id, ok: false, failure: 'too-large' };
    }
    return { id, ok: true, svg: result.svg, width: result.width, height: result.height, kind: result.type };
  } catch (error) {
    return { id, ok: false, failure: error instanceof PeleError ? failureOf(error) : 'failed' };
  }
}
