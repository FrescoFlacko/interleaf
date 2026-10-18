/**
 * Contract for rendering a fenced `mermaid` block found in a document.
 *
 * A diagram source is untrusted declarative document data, never executable
 * document code. The renderer asks main for a picture; main renders it in a
 * separate, network-denied, API-free process it owns and can terminate, and
 * answers with inert SVG markup or a typed failure. Nothing the document wrote
 * reaches the reader's surface as markup, script, style, or a resource URL.
 */

import type { z } from 'zod';
import type {
  mermaidAppearanceSchema,
  mermaidFailureReasonSchema,
  mermaidRenderRequestSchema,
  mermaidRenderResultSchema,
  mermaidSandboxResultSchema,
} from '../schemas/mermaid';

/** The two appearances a diagram is drawn for; the reader supplies neither colour. */
export type MermaidAppearance = z.output<typeof mermaidAppearanceSchema>;

/**
 * Why a diagram could not be drawn.
 *
 * Every value is a description of Interleaf's own policy or of the diagram
 * source. None carries a path, a host, or renderer output.
 */
export type MermaidFailureReason = z.output<typeof mermaidFailureReasonSchema>;

export type MermaidRenderRequest = z.output<typeof mermaidRenderRequestSchema>;

export type MermaidRenderResult = z.output<typeof mermaidRenderResultSchema>;
/** Inert, self-contained SVG markup with its intrinsic size in CSS pixels. */
export type MermaidRenderSuccess = Extract<MermaidRenderResult, { status: 'rendered' }>;

/**
 * The job the isolated renderer receives and the result it returns. These cross
 * a `main -> isolated window` boundary only; they are never renderer input.
 */
export type MermaidSandboxJob = {
  readonly jobId: string;
  readonly source: string;
  readonly appearance: MermaidAppearance;
  readonly maxSvgBytes: number;
  readonly maxDimension: number;
};

export type MermaidSandboxResult = z.output<typeof mermaidSandboxResultSchema>;
