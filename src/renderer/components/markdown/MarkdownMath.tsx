import { createElement, useMemo, type ReactNode } from 'react';
import { renderMathMl } from './markdown-math';

/** MathML Core presentation elements. Anything else is dropped with its subtree. */
const MATHML_ELEMENTS = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
  'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts',
  'mprescripts', 'none', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mpadded',
  'mphantom', 'menclose', 'mtable', 'mtr', 'mtd',
]);

/** Presentation attributes only: no `href`, no event handlers, no `style`. */
const MATHML_ATTRIBUTES = new Set([
  'display', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathcolor', 'mathbackground',
  'stretchy', 'fence', 'separator', 'largeop', 'movablelimits', 'symmetric', 'accent',
  'accentunder', 'lspace', 'rspace', 'minsize', 'maxsize', 'linethickness', 'width',
  'height', 'depth', 'voffset', 'notation', 'columnalign', 'rowalign', 'columnspacing',
  'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns',
]);

function toReact(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const name = element.localName;
  if (!MATHML_ELEMENTS.has(name)) return null;
  const props: Record<string, string> = { key };
  for (const attribute of Array.from(element.attributes)) {
    if (MATHML_ATTRIBUTES.has(attribute.name)) props[attribute.name] = attribute.value;
  }
  const children = Array.from(element.childNodes).map((child, index) => toReact(child, `${key}-${String(index)}`));
  return createElement(name, props, ...children);
}

/** The `<math>` element of KaTeX's output, parsed into an inert document. */
function parseMath(markup: string): Element | null {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  return parsed.querySelector('math');
}

type MarkdownMathProps = {
  readonly tex: string;
  readonly display: boolean;
};

/**
 * One TeX expression rendered as native MathML.
 *
 * KaTeX's output is rebuilt element by element through an allowlist, so the
 * DOM holds only presentation MathML and text, never markup a model supplied.
 * TeX that does not parse stays visible as its source rather than vanishing.
 */
export function MarkdownMath({ tex, display }: MarkdownMathProps) {
  const math = useMemo(() => {
    const markup = renderMathMl(tex, display);
    const root = markup === null ? null : parseMath(markup);
    return root === null ? null : toReact(root, 'math');
  }, [tex, display]);

  if (math === null) {
    return (
      <code data-testid="markdown-math-source" className="break-all font-mono text-[0.9em] text-text-primary">
        {tex}
      </code>
    );
  }
  return display ? (
    <span data-testid="markdown-math" data-display="block" className="my-2 block max-w-full overflow-x-auto text-center">
      {math}
    </span>
  ) : (
    <span data-testid="markdown-math" data-display="inline">{math}</span>
  );
}
