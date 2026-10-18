import { z } from 'zod';

/**
 * Fixed bounds for diagram rendering. Every one of these is a product
 * constant: no document, directive, setting, or renderer message can raise
 * one, and main re-applies them after the renderer has already checked them.
 */
export const MERMAID_LIMITS = {
  /** Largest fenced source accepted, in UTF-16 units. */
  maxSourceLength: 20_000,
  /** Largest fenced source accepted, in lines. */
  maxSourceLines: 600,
  /** Diagrams drawn per open document; later fences keep their source only. */
  maxDiagramsPerDocument: 40,
  /** Wall-clock deadline for one render, after which the process is killed. */
  renderTimeoutMs: 6_000,
  /** Largest SVG accepted from the renderer, in UTF-16 units. */
  maxSvgLength: 2 * 1024 * 1024,
  /** Largest intrinsic diagram edge accepted, in CSS pixels. */
  maxDimension: 8_000,
  /** Jobs main will hold while one is drawing. */
  maxQueuedJobs: 16,
} as const;

export const mermaidAppearanceSchema = z.enum(['light', 'dark']);

export const mermaidRenderRequestSchema = z
  .object({
    source: z.string().max(MERMAID_LIMITS.maxSourceLength),
    appearance: mermaidAppearanceSchema,
  })
  .strict();

export const mermaidFailureReasonSchema = z.enum([
  /** The source is not a diagram this Mermaid build can parse. */
  'invalid-syntax',
  /** Parsed, but the diagram type is not one this reader draws. */
  'unsupported-diagram',
  /** The fenced source is larger than the fixed input bound. */
  'source-too-large',
  /** The drawing exceeded the fixed output byte or dimension bounds. */
  'output-too-large',
  /** The render did not finish inside the fixed deadline and was terminated. */
  'timeout',
  /** The renderer process is unavailable, over capacity, or shutting down. */
  'unavailable',
  /** Output failed the inert-SVG guard and was discarded rather than shown. */
  'rejected-output',
]);

export const mermaidRenderResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('rendered'),
        svg: z.string().min(1).max(MERMAID_LIMITS.maxSvgLength),
        width: z.number().int().positive().max(MERMAID_LIMITS.maxDimension),
        height: z.number().int().positive().max(MERMAID_LIMITS.maxDimension),
      })
      .strict(),
    z.object({ status: z.literal('failed'), reason: mermaidFailureReasonSchema }).strict(),
  ]
);

/** The result shape the isolated renderer returns to main, before re-checking. */
export const mermaidSandboxResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      jobId: z.string().min(1).max(64),
      status: z.literal('rendered'),
      svg: z.string().min(1).max(MERMAID_LIMITS.maxSvgLength),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .strict(),
  z
    .object({
      jobId: z.string().min(1).max(64),
      status: z.literal('failed'),
      reason: mermaidFailureReasonSchema,
    })
    .strict(),
]);

/** Bound on how many directive spans this pass removes from one source. */
const MAX_DIRECTIVE_SPANS = 64;

/**
 * Strips `%%{ ... }%%` configuration directives from a diagram source.
 *
 * A directive is Mermaid's in-source configuration channel: it is how a
 * document would ask for `htmlLabels`, a theme, custom CSS, or a larger text
 * budget. Interleaf fixes all of those, so a directive is removed before the
 * source reaches the renderer rather than trusted to be refused there. The
 * renderer also pins the same keys as non-overridable, so this is the outer of
 * two layers, not the only one.
 *
 * The scan is bounded: past `MAX_DIRECTIVE_SPANS` spans the rest of the source
 * is appended as it was, so a source carrying more directives than that keeps
 * the later ones. Nothing downstream depends on this pass being exhaustive —
 * the renderer's own pinned configuration is what makes an override ineffective
 * — but the removal is not a guarantee that no directive text reaches it.
 */
function stripDirectives(source: string): { readonly text: string; readonly stripped: boolean } {
  let text = '';
  let index = 0;
  let stripped = false;
  let spans = 0;
  while (index < source.length) {
    const open = source.indexOf('%%{', index);
    if (open === -1 || spans >= MAX_DIRECTIVE_SPANS) {
      text += source.slice(index);
      break;
    }
    text += source.slice(index, open);
    // A directive closes with `}%%`, and Mermaid also tolerates `}%`. Take the
    // earliest close; an unterminated directive consumes the rest of the line,
    // which is what Mermaid's own line-oriented scanner would see.
    const closeFull = source.indexOf('}%%', open + 3);
    const closeShort = source.indexOf('}%', open + 3);
    const lineEnd = source.indexOf('\n', open + 3);
    let next: number;
    if (closeFull !== -1) next = closeFull + 3;
    else if (closeShort !== -1) next = closeShort + 2;
    else if (lineEnd !== -1) next = lineEnd;
    else next = source.length;
    index = next;
    stripped = true;
    spans += 1;
  }
  return { text, stripped };
}

/** Top-level YAML frontmatter keys a document may keep. */
const ALLOWED_FRONTMATTER_KEYS = new Set(['title']);

/**
 * Reduces a diagram's YAML frontmatter to the keys that describe the picture
 * rather than configure the renderer.
 *
 * `config:` in frontmatter is the same override channel as a directive, so only
 * an allow-listed key survives. A frontmatter block that keeps nothing is
 * removed entirely rather than left as an empty fence Mermaid would reject.
 */
function stripFrontmatterConfig(source: string): {
  readonly text: string;
  readonly stripped: boolean;
} {
  if (!source.startsWith('---')) return { text: source, stripped: false };
  const lines = source.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { text: source, stripped: false };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed === '---' || trimmed === '...') {
      end = index;
      break;
    }
  }
  if (end === -1) return { text: source, stripped: false };

  const kept: string[] = [];
  let stripped = false;
  let insideRejectedBlock = false;
  for (const line of lines.slice(1, end)) {
    const isTopLevelKey = /^[A-Za-z0-9_-]+\s*:/.test(line);
    if (isTopLevelKey) {
      const key = (/^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1] ?? '').toLowerCase();
      insideRejectedBlock = !ALLOWED_FRONTMATTER_KEYS.has(key);
      if (insideRejectedBlock) {
        stripped = true;
        continue;
      }
      kept.push(line);
      continue;
    }
    // A continuation line belongs to whichever key opened the block.
    if (insideRejectedBlock) {
      stripped = true;
      continue;
    }
    kept.push(line);
  }

  const body = lines.slice(end + 1).join('\n');
  if (kept.length === 0) return { text: body, stripped };
  return { text: ['---', ...kept, '---', body].join('\n'), stripped };
}

export type MermaidSourcePolicyResult =
  | {
      readonly status: 'accepted';
      /** The source the renderer will draw, with override channels removed. */
      readonly source: string;
      /** True when a directive or frontmatter configuration block was removed. */
      readonly overridesRemoved: boolean;
    }
  | { readonly status: 'rejected'; readonly reason: 'source-too-large' | 'empty' };

/**
 * Applies the fixed source policy to one fenced diagram.
 *
 * Runs in main before a job is dispatched, so a renderer that skipped it — or
 * lied about having run it — changes nothing about what is drawn.
 */
export function applyMermaidSourcePolicy(rawSource: string): MermaidSourcePolicyResult {
  if (rawSource.length > MERMAID_LIMITS.maxSourceLength) {
    return { status: 'rejected', reason: 'source-too-large' };
  }
  const normalized = rawSource.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.split('\n').length > MERMAID_LIMITS.maxSourceLines) {
    return { status: 'rejected', reason: 'source-too-large' };
  }
  const withoutFrontmatter = stripFrontmatterConfig(normalized);
  const withoutDirectives = stripDirectives(withoutFrontmatter.text);
  const source = withoutDirectives.text.trim();
  if (source.length === 0) return { status: 'rejected', reason: 'empty' };
  return {
    status: 'accepted',
    source,
    overridesRemoved: withoutFrontmatter.stripped || withoutDirectives.stripped,
  };
}

/** Reader-facing wording for a diagram that was not drawn. */
export function describeMermaidFailure(result: z.output<typeof mermaidRenderResultSchema>): string | null {
  if (result.status === 'rendered') return null;
  switch (result.reason) {
    case 'invalid-syntax':
      return 'This diagram could not be drawn because its source is not valid Mermaid.';
    case 'unsupported-diagram':
      return 'This diagram type is not supported here. The source is shown instead.';
    case 'source-too-large':
      return 'This diagram is too large to draw. The source is shown instead.';
    case 'output-too-large':
      return 'This diagram drew larger than the supported size. The source is shown instead.';
    case 'timeout':
      return 'This diagram took too long to draw and was stopped. The source is shown instead.';
    case 'rejected-output':
      return 'This diagram was not displayed because its drawing failed a safety check.';
    case 'unavailable':
      return 'Diagram rendering is unavailable right now. The source is shown instead.';
  }
}
