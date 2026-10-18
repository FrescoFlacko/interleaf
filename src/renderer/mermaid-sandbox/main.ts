/**
 * The only script that runs in the isolated diagram renderer.
 *
 * This page has no preload, no bridge, and no application API. It exposes one
 * function on `window`, which main calls with one job and which answers with
 * one result object. Everything it needs — the library, the configuration, the
 * bounds — is fixed here or arrives in that job; nothing is read from the
 * document, from storage, or from the network.
 *
 * Configuration is deliberately not negotiable. The security level, label mode,
 * theme, and text budget are set once, before any diagram is seen, and the
 * `secure` list names them so an in-source directive that survived main's
 * stripping still cannot change them.
 */
import mermaid from 'mermaid';
import type { MermaidAppearance, MermaidSandboxJob, MermaidSandboxResult } from '@shared/types/mermaid';
import { SvgSanitizeError, sanitizeRenderedSvg } from './svg-allowlist';

/** Configuration keys no diagram source may set, whatever it writes. */
const LOCKED_CONFIG_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'theme',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
  'flowchart',
  'sequence',
  'gantt',
  'journey',
  'class',
  'state',
  'er',
  'pie',
  'deterministicIds',
  'deterministicIDSeed',
  'logLevel',
  'arrowMarkerAbsolute',
  'wrap',
] as const;

/**
 * Colours for the two appearances.
 *
 * The reader tells the renderer which appearance to draw for; it never supplies
 * a colour, and no document can name one. These are fixed pairs chosen to keep
 * labels readable against each reader background.
 */
const THEME_VARIABLES: Record<MermaidAppearance, Record<string, string>> = {
  light: {
    background: '#ffffff',
    primaryColor: '#eef2f7',
    primaryTextColor: '#1f2933',
    primaryBorderColor: '#7b8794',
    secondaryColor: '#e4e9f0',
    tertiaryColor: '#f6f8fa',
    lineColor: '#52606d',
    textColor: '#1f2933',
    mainBkg: '#eef2f7',
    nodeBorder: '#7b8794',
    clusterBkg: '#f6f8fa',
    clusterBorder: '#cbd2d9',
    edgeLabelBackground: '#ffffff',
    labelBackground: '#ffffff',
  },
  dark: {
    background: '#1b1d1f',
    primaryColor: '#2b3038',
    primaryTextColor: '#e8eaed',
    primaryBorderColor: '#8b95a1',
    secondaryColor: '#343b45',
    tertiaryColor: '#24282d',
    tertiaryTextColor: '#e8eaed',
    lineColor: '#a7b0bb',
    textColor: '#e8eaed',
    mainBkg: '#2b3038',
    nodeBorder: '#8b95a1',
    clusterBkg: '#24282d',
    clusterBorder: '#3f464f',
    edgeLabelBackground: '#1b1d1f',
    labelBackground: '#1b1d1f',
  },
};

/** Fonts are the ones the page already has; a diagram never names a webfont. */
const DIAGRAM_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

let configuredAppearance: MermaidAppearance | null = null;

function configure(appearance: MermaidAppearance, maxTextSize: number): void {
  if (configuredAppearance === appearance) return;
  mermaid.initialize({
    startOnLoad: false,
    // `strict` is the library's own refusal to emit HTML labels, click
    // handlers, and link targets from a diagram source.
    securityLevel: 'strict',
    secure: [...LOCKED_CONFIG_KEYS],
    suppressErrorRendering: true,
    logLevel: 'fatal',
    theme: 'base',
    themeVariables: THEME_VARIABLES[appearance],
    fontFamily: DIAGRAM_FONT_FAMILY,
    // Text labels are drawn as SVG text, never as embedded HTML.
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    class: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    maxTextSize,
    maxEdges: 500,
    // Ids must not depend on how many diagrams ran before this one: a hidden
    // renderer is reused across documents and reopened readers.
    deterministicIds: true,
    deterministicIDSeed: 'interleaf-diagram',
  });
  configuredAppearance = appearance;
}

/** The element the layout engine measures text in; cleared after every job. */
function stagingElement(): HTMLElement {
  const existing = document.getElementById('stage');
  if (existing !== null) return existing;
  const created = document.createElement('div');
  created.id = 'stage';
  document.body.appendChild(created);
  return created;
}

/**
 * Tells a source the library cannot parse apart from one it parses but will not
 * draw. Both end in the fenced source being shown, with different wording.
 */
async function classifyFailure(source: string): Promise<'invalid-syntax' | 'unsupported-diagram'> {
  try {
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    return parsed === false ? 'invalid-syntax' : 'unsupported-diagram';
  } catch {
    return 'invalid-syntax';
  }
}

async function renderJob(job: MermaidSandboxJob): Promise<MermaidSandboxResult> {
  const stage = stagingElement();
  stage.textContent = '';
  configure(job.appearance, Math.min(job.maxSvgBytes, 50_000));

  let rendered: string;
  try {
    const result = await mermaid.render('interleaf-diagram', job.source, stage);
    rendered = result.svg;
  } catch {
    return { jobId: job.jobId, status: 'failed', reason: await classifyFailure(job.source) };
  } finally {
    stage.textContent = '';
  }

  if (rendered.length > job.maxSvgBytes) {
    return { jobId: job.jobId, status: 'failed', reason: 'output-too-large' };
  }

  try {
    const sanitized = sanitizeRenderedSvg(rendered, job.maxDimension);
    return {
      jobId: job.jobId,
      status: 'rendered',
      svg: sanitized.markup,
      width: sanitized.width,
      height: sanitized.height,
    };
  } catch (error) {
    const reason =
      error instanceof SvgSanitizeError && error.message === 'dimensions'
        ? 'output-too-large'
        : 'rejected-output';
    return { jobId: job.jobId, status: 'failed', reason };
  }
}

/**
 * One job at a time, answered as a plain JSON-serializable object.
 *
 * A thrown error here would cross back to main as a message string built from
 * library internals, so every path returns a typed result instead. Main still
 * re-validates the shape it receives.
 */
type MermaidSandboxEntryPoint = {
  __interleafRenderMermaid: (job: MermaidSandboxJob) => Promise<MermaidSandboxResult>;
};

const entryPoint: MermaidSandboxEntryPoint = {
  __interleafRenderMermaid: async (job: MermaidSandboxJob): Promise<MermaidSandboxResult> => {
    try {
      return await renderJob(job);
    } catch {
      return { jobId: job.jobId, status: 'failed', reason: 'unavailable' };
    }
  },
};
Object.assign(window, entryPoint);
