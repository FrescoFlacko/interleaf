import { Marked, type Token, type Tokens } from 'marked';
import { useMemo, type ReactNode } from 'react';
import type { ChatCitation } from '@shared/types/ai';
import { CITATION_MARKER_PATTERN, chatCitationLabel, isGroundedSourceId } from '@shared/chat-citation-label';
import { MarkdownMath } from './MarkdownMath';
import { mathExtensions, type MathToken } from './markdown-math';
import { MarkdownFence, useDiagramFences } from './diagram/MarkdownFence';

type MarkdownContentProps = {
  readonly content: string;
  /**
   * Citation envelope of the surface showing the content. Surfaces that have no
   * envelope (a saved note keeps only its text) omit it, so citation-looking
   * text such as `[src-1]` stays ordinary text instead of a jump control.
   */
  readonly citations?: ReadonlyMap<string, ChatCitation>;
  readonly onCitation?: (sourceId: string) => Promise<void>;
  /**
   * While an answer is still streaming its envelope has not arrived, so a
   * grounded `src-N` marker it does not yet name is shown as an inert pending chip rather than
   * as raw text. Once the answer settles this is off, and only markers the
   * validated envelope names become citations; any other stays literal text.
   */
  readonly pendingCitations?: boolean;
  /** Tooltip on the inert placeholder that replaces an embedded image. */
  readonly imageTitle?: string;
  /**
   * Draw complete ` ```mermaid ` fences as diagrams. Only AI chat and agent
   * output opt in; notes keep every fence as code.
   */
  readonly diagrams?: boolean;
  /** Keep diagram fences as source for now, e.g. while the reply is still streaming. */
  readonly deferDiagrams?: boolean;
};

/** Per-surface rendering inputs threaded through the token walk. */
type MarkdownRenderOptions = {
  readonly citations: ReadonlyMap<string, ChatCitation>;
  readonly onCitation: (sourceId: string) => Promise<void>;
  readonly pendingCitations: boolean;
  readonly imageTitle: string;
  readonly diagramFences: ReadonlySet<Tokens.Code>;
};

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
const NO_CITATIONS: ReadonlyMap<string, ChatCitation> = new Map();
const IGNORE_CITATION = (): Promise<void> => Promise.resolve();
const DEFAULT_IMAGE_TITLE = 'Embedded images are not displayed';
const markdown = new Marked({ gfm: true, breaks: true, extensions: [...mathExtensions] });

/**
 * Render untrusted Markdown from marked's token stream instead of its HTML
 * output. React escapes every text node, and the explicit token mapping keeps
 * raw HTML, images, and unsafe URLs inert by construction.
 *
 * This is the single Markdown implementation for every renderer surface: chat
 * messages (through `MarkdownMessage`), agent output and saved annotation note
 * bodies.
 */
export function MarkdownContent({
  content,
  citations = NO_CITATIONS,
  onCitation = IGNORE_CITATION,
  pendingCitations = false,
  imageTitle = DEFAULT_IMAGE_TITLE,
  diagrams,
  deferDiagrams,
}: MarkdownContentProps) {
  const tokens = useMemo(() => {
    try {
      return markdown.lexer(content);
    } catch {
      // A partial stream can be malformed while a provider is still writing.
      // Showing it as escaped text is preferable to dropping the response.
      return [{ type: 'text', raw: content, text: content } satisfies Tokens.Text];
    }
  }, [content]);
  const diagramFences = useDiagramFences(tokens, diagrams, deferDiagrams);
  const options: MarkdownRenderOptions = { citations, onCitation, pendingCitations, imageTitle, diagramFences };

  return (
    <div data-testid="markdown-content" className="min-w-0 max-w-full break-words">
      {renderTokens(tokens, options, 'root')}
    </div>
  );
}

function renderTokens(
  tokens: readonly Token[],
  options: MarkdownRenderOptions,
  keyPrefix: string,
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${String(index)}`;
    if (isMathToken(token)) return <MarkdownMath key={key} tex={token.tex} display={token.display} />;
    return renderToken(token, options, key);
  });
}

function isMathToken(token: Token): token is MathToken {
  return token.type === 'math';
}

function renderToken(
  token: Token,
  options: MarkdownRenderOptions,
  key: string,
): ReactNode {
  switch (token.type) {
    case 'space':
      return <span key={key} aria-hidden="true" className="block h-2" />;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = headingTag(heading.depth);
      const depth = Math.min(6, Math.max(1, Math.trunc(heading.depth)));
      return (
        <Tag
          key={key}
          data-testid={`markdown-heading-${String(depth)}`}
          className={headingClass(depth)}
        >
          {renderTokens(heading.tokens, options, key)}
        </Tag>
      );
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return (
        <p key={key} className="mb-2 last:mb-0">
          {renderTokens(paragraph.tokens, options, key)}
        </p>
      );
    }
    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      return (
        <blockquote key={key} className="my-2 border-l-2 border-accent/50 pl-3 italic text-text-secondary">
          {renderTokens(quote.tokens, options, key)}
        </blockquote>
      );
    }
    case 'list': {
      const list = token as Tokens.List;
      const children = list.items.map((item, index) => renderToken(item, options, `${key}-${String(index)}`));
      return list.ordered ? (
        <ol key={key} start={list.start === '' ? undefined : list.start} className="my-2 list-inside list-decimal space-y-1">
          {children}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-inside list-disc space-y-1">
          {children}
        </ul>
      );
    }
    case 'list_item': {
      const item = token as Tokens.ListItem;
      return (
        <li key={key} className="break-words">
          {item.task && (
            <input
              type="checkbox"
              checked={item.checked === true}
              disabled
              aria-label={item.checked === true ? 'Completed task' : 'Incomplete task'}
              className="mr-1 align-middle"
              readOnly
            />
          )}
          {renderTokens(item.tokens, options, key)}
        </li>
      );
    }
    case 'code': {
      return <MarkdownFence key={key} token={token as Tokens.Code} diagramFences={options.diagramFences} />;
    }
    case 'codespan': {
      const code = token as Tokens.Codespan;
      return (
        <code key={key} className="break-all rounded bg-bg-surface px-1 py-0.5 font-mono text-[0.9em] text-text-primary">
          {code.text}
        </code>
      );
    }
    case 'strong': {
      const strong = token as Tokens.Strong;
      return <strong key={key}>{renderTokens(strong.tokens, options, key)}</strong>;
    }
    case 'em': {
      const emphasis = token as Tokens.Em;
      return <em key={key}>{renderTokens(emphasis.tokens, options, key)}</em>;
    }
    case 'del': {
      const deleted = token as Tokens.Del;
      return <del key={key}>{renderTokens(deleted.tokens, options, key)}</del>;
    }
    case 'link': {
      const link = token as Tokens.Link;
      return renderLink(link, options, key);
    }
    case 'image': {
      const image = token as Tokens.Image;
      return (
        <span
          key={key}
          data-testid="markdown-image-inert"
          title={options.imageTitle}
          className="rounded border border-border-subtle px-1 text-text-secondary"
        >
          [{image.text}]
        </span>
      );
    }
    case 'hr':
      return <hr key={key} className="my-3 border-border-subtle" />;
    case 'br':
      return <br key={key} />;
    case 'html': {
      const html = token as Tokens.HTML | Tokens.Tag;
      return (
        <span key={key} data-testid="markdown-raw-html" className="whitespace-pre-wrap">
          {html.raw}
        </span>
      );
    }
    case 'text': {
      const text = token as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) {
        return <span key={key}>{renderTokens(text.tokens, options, key)}</span>;
      }
      return <span key={key}>{renderCitations(text.text, options, key)}</span>;
    }
    case 'escape': {
      const escaped = token as Tokens.Escape;
      return <span key={key}>{renderCitations(escaped.text, options, key)}</span>;
    }
    case 'table': {
      const table = token as Tokens.Table;
      return (
        <div key={key} className="my-2 max-w-full overflow-x-auto">
          <table className="min-w-full border-collapse text-left">
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={`${key}-header-${String(index)}`} scope="col" className="border border-border-subtle px-2 py-1 font-semibold">
                    {renderTokens(cell.tokens, options, `${key}-header-${String(index)}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${String(rowIndex)}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-cell-${String(rowIndex)}-${String(cellIndex)}`} className="border border-border-subtle px-2 py-1">
                      {renderTokens(cell.tokens, options, `${key}-cell-${String(rowIndex)}-${String(cellIndex)}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'def':
      return null;
    default: {
      const generic = token as Tokens.Generic;
      return <span key={key}>{renderCitations(generic.raw, options, key)}</span>;
    }
  }
}

function renderLink(
  link: Tokens.Link,
  options: MarkdownRenderOptions,
  key: string,
): ReactNode {
  // A link's own text never produces a document citation chip. Otherwise a
  // model that wrote `[src-1](https://elsewhere.test)` would render a control
  // that jumps into this document while wearing a web link's decoration, which
  // is exactly the confusion the two forms have to avoid.
  const children = renderTokens(link.tokens, { ...options, citations: NO_CITATIONS, pendingCitations: false }, key);
  if (!isSafeExternalUrl(link.href)) {
    return (
      <span key={key} data-testid="markdown-link-inert" title="Unsafe or unsupported links are disabled" className="break-all underline decoration-dotted">
        {children}
      </span>
    );
  }

  // The current typed bridge intentionally has no external-navigation method.
  // Keep external links inert until a main-owned safe-open operation exists.
  //
  // A web citation is shown with its validated host beside it so a reader can
  // tell where an answer's claim came from, and so a web source is visibly a
  // different thing from a document citation chip: `[src-*]` chips navigate
  // this document, a web host never does.
  const host = externalUrlHost(link.href);
  return (
    <span
      key={key}
      data-testid="markdown-link-inert"
      data-link-kind="web"
      data-link-host={host}
      title={`External link: ${link.href}`}
      className="break-all underline decoration-dotted"
    >
      {children}
      <span data-testid="markdown-link-host" className="ml-1 whitespace-nowrap text-2xs no-underline text-text-secondary">
        ({host})
      </span>
    </span>
  );
}

/** Host of an already-validated `http(s)` URL, for display only. */
function externalUrlHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return 'web';
  }
}

/**
 * What a marker renders as: the citation the envelope binds it to, an inert
 * pending chip for a grounded `src-N` marker still awaiting its envelope, or
 * `null` to leave it as the literal text it is.
 */
function markerCitation(sourceId: string, options: MarkdownRenderOptions): ChatCitation | 'pending' | null {
  const citation = options.citations.get(sourceId);
  if (citation) return citation;
  return options.pendingCitations && isGroundedSourceId(sourceId) ? 'pending' : null;
}

function renderCitations(
  text: string,
  options: MarkdownRenderOptions,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  CITATION_MARKER_PATTERN.lastIndex = 0;
  while ((match = CITATION_MARKER_PATTERN.exec(text)) !== null) {
    const sourceId = match[1] ?? '';
    const citation = markerCitation(sourceId, options);
    if (citation === null) continue;
    if (match.index > cursor) nodes.push(<span key={`${keyPrefix}-text-${String(cursor)}`}>{text.slice(cursor, match.index)}</span>);
    cursor = match.index + match[0].length;
    if (citation === 'pending') {
      nodes.push(
        <span
          key={`${keyPrefix}-pending-${String(match.index)}`}
          data-testid="citation-pending"
          className="mx-0.5 inline-flex rounded-full border border-border-subtle px-1.5 py-0.5 text-2xs text-text-secondary"
        >
          source
        </span>,
      );
      continue;
    }
    nodes.push(
      <button
        key={`${keyPrefix}-citation-${sourceId}-${String(match.index)}`}
        type="button"
        title={`Jump to ${citation.label}`}
        onClick={() => { void options.onCitation(sourceId); }}
        className="mx-0.5 inline-flex rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent hover:bg-accent/20"
      >
        {chatCitationLabel(citation)}
      </button>,
    );
  }
  if (cursor < text.length) nodes.push(<span key={`${keyPrefix}-text-${String(cursor)}`}>{text.slice(cursor)}</span>);
  if (nodes.length === 0 && text.length > 0) nodes.push(<span key={`${keyPrefix}-text`}>{text}</span>);
  return nodes;
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function headingTag(depth: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const normalized = Math.min(6, Math.max(1, Math.trunc(depth)));
  return `h${String(normalized)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}

function headingClass(depth: number): string {
  const classes: Record<number, string> = {
    1: 'mb-2 mt-2 max-w-full break-words text-xl font-bold leading-tight text-text-primary first:mt-0',
    2: 'mb-2 mt-2 max-w-full break-words text-lg font-bold leading-tight text-text-primary first:mt-0',
    3: 'mb-1 mt-2 max-w-full break-words text-base font-semibold leading-snug text-text-primary first:mt-0',
    4: 'mb-1 mt-2 max-w-full break-words text-sm font-semibold leading-snug text-text-primary first:mt-0',
    5: 'mb-1 mt-2 max-w-full break-words text-xs font-semibold leading-snug text-text-primary first:mt-0',
    6: 'mb-1 mt-2 max-w-full break-words text-2xs font-semibold uppercase tracking-wide leading-snug text-text-secondary first:mt-0',
  };
  return classes[depth] ?? classes[6] ?? '';
}
