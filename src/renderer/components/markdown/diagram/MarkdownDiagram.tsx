import { memo, useId, useState } from 'react';
import { AppIcon } from '../../AppIcon';
import { MarkdownCodeBlock } from '../MarkdownCodeBlock';
import type { DiagramFailure } from './diagram-protocol';
import { useDiagramRender } from './use-diagram-render';

/** Short, generic reasons. Library messages quote the source and are never shown. */
const FAILURE_TEXT: Readonly<Record<DiagramFailure, string>> = {
  unsupported: "This diagram type isn't supported; showing its source.",
  invalid: "This diagram couldn't be read; showing its source.",
  'too-large': 'This diagram is too large to draw; showing its source.',
  timeout: 'This diagram took too long to draw; showing its source.',
  busy: "Too many diagrams are waiting to be drawn; showing this one's source.",
  failed: "This diagram couldn't be drawn; showing its source.",
};

function kindLabel(kind: string): string {
  const words = kind.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

type DiagramProps = { readonly code: string; readonly info: string };

function RenderedDiagram({
  code,
  info,
  url,
  width,
  height,
  kind,
}: DiagramProps & { readonly url: string; readonly width: number; readonly height: number; readonly kind: string }) {
  const [showSource, setShowSource] = useState(false);
  const sourceId = useId();
  const label = `${kindLabel(kind)} diagram`;

  return (
    <figure data-testid="markdown-diagram" data-diagram-kind={kind} className="my-2 max-w-full overflow-hidden rounded border border-border-subtle bg-bg-primary">
      <figcaption className="flex items-center gap-2 border-b border-border-subtle px-2 py-1 text-2xs text-text-secondary">
        <AppIcon name="code-block" size={12} />
        <span className="min-w-0 truncate font-mono uppercase tracking-wide">{label}</span>
        <button
          type="button"
          data-testid="markdown-diagram-source-toggle"
          aria-expanded={showSource}
          aria-controls={sourceId}
          onClick={() => {
            setShowSource((shown) => !shown);
          }}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-text-secondary hover:bg-bg-surface hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
        >
          {showSource ? 'Hide source' : 'Show source'}
        </button>
      </figcaption>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        data-testid="markdown-diagram-scroll"
        className="max-w-full overflow-x-auto p-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring"
      >
        <img
          data-testid="markdown-diagram-image"
          src={url}
          alt={label}
          width={width}
          height={height}
          draggable={false}
          className="block max-w-none"
        />
      </div>
      <div id={sourceId} hidden={!showSource} className="border-t border-border-subtle px-2">
        {showSource && <MarkdownCodeBlock code={code} info={info} />}
      </div>
    </figure>
  );
}

/**
 * A complete Mermaid fence from model output, drawn locally with Pele.
 *
 * Until the worker answers, and whenever it cannot draw the fence, the source
 * is shown as an ordinary code block — with a short reason after a failure — so
 * the reply always reads in full. A drawing is an inert `<img>` of sanitized
 * SVG; its source stays one click away, with the code block's Copy control.
 */
export const MarkdownDiagram = memo(function MarkdownDiagram({ code, info }: DiagramProps) {
  const view = useDiagramRender(code);
  if (view.status === 'ready') {
    return <RenderedDiagram code={code} info={info} url={view.url} width={view.width} height={view.height} kind={view.kind} />;
  }
  if (view.status === 'pending') {
    return (
      <div data-testid="markdown-diagram-pending" aria-busy="true">
        <MarkdownCodeBlock code={code} info={info} />
      </div>
    );
  }
  return (
    <div data-testid="markdown-diagram-fallback" data-diagram-failure={view.failure}>
      <p role="note" className="mt-2 text-2xs text-text-secondary">
        {FAILURE_TEXT[view.failure]}
      </p>
      <MarkdownCodeBlock code={code} info={info} />
    </div>
  );
});
