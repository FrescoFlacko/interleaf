import { useMemo } from 'react';
import type { Token, Tokens } from 'marked';
import { MarkdownCodeBlock } from '../MarkdownCodeBlock';
import { selectDiagramFences } from './diagram-fence';
import { MAX_DIAGRAMS_PER_MESSAGE } from './diagram-protocol';
import { MarkdownDiagram } from './MarkdownDiagram';

const NO_DIAGRAMS: ReadonlySet<Tokens.Code> = new Set();

/**
 * The fences of one message to draw as diagrams: none unless the surface opted
 * in, and none while drawing is deferred (e.g. the reply is still streaming).
 */
export function useDiagramFences(tokens: readonly Token[], enabled = false, deferred = false): ReadonlySet<Tokens.Code> {
  const active = enabled && !deferred;
  return useMemo(() => (active ? selectDiagramFences(tokens, MAX_DIAGRAMS_PER_MESSAGE) : NO_DIAGRAMS), [active, tokens]);
}

type MarkdownFenceProps = {
  readonly token: Tokens.Code;
  readonly diagramFences: ReadonlySet<Tokens.Code>;
};

/** A fenced code block, drawn as a diagram when it was selected for one. */
export function MarkdownFence({ token, diagramFences }: MarkdownFenceProps) {
  const info = token.lang ?? '';
  if (diagramFences.has(token)) return <MarkdownDiagram code={token.text} info={info} />;
  return <MarkdownCodeBlock code={token.text} info={info} />;
}
