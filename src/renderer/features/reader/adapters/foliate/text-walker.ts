// Text walker ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

const walkRange = (range: Range, walker: TreeWalker): Node[] => {
  const nodes: Node[] = [];
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    const compare = range.comparePoint(node, 0);
    if (compare === 0) nodes.push(node);
    else if (compare > 0) break;
  }
  return nodes;
};

const walkDocument = (_: Document | Element, walker: TreeWalker): Node[] => {
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node);
  }
  return nodes;
};

const filter = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION;

const defaultAcceptNode = (node: Node): number => {
  if (node.nodeType === 1) {
    const name = (node as Element).tagName.toLowerCase();
    if (name === 'script' || name === 'style' || name === 'noscript') return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_SKIP;
  }
  return NodeFilter.FILTER_ACCEPT;
};

export type TextMatchCallback<T> = (
  strs: string[],
  makeRange: (startIndex: number, startOffset: number, endIndex: number, endOffset: number) => Range
) => Iterable<T>;

export const textWalker = function* <T>(
  x: Document | Element | Range,
  func: TextMatchCallback<T>,
  filterFunc?: (node: Node) => number
): Generator<T> {
  const root =
    'commonAncestorContainer' in x
      ? x.commonAncestorContainer
      : x.nodeType === Node.DOCUMENT_NODE
      ? (x as Document).body
      : x;

  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, filter, {
    acceptNode: filterFunc ?? defaultAcceptNode,
  });

  const walk = 'commonAncestorContainer' in x ? walkRange : walkDocument;
  const nodes = walk(x as never, walker);
  const strs = nodes.map((node) => node.nodeValue ?? '');

  const makeRange = (
    startIndex: number,
    startOffset: number,
    endIndex: number,
    endOffset: number
  ): Range => {
    const range = doc.createRange();
    const startNode = nodes[startIndex];
    const endNode = nodes[endIndex];
    if (!startNode || !endNode) throw new RangeError('Text match range is outside the document');
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  };

  for (const match of func(strs, makeRange)) {
    yield match;
  }
};
