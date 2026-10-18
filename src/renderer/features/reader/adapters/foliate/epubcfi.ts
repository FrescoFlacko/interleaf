// EPUB CFI implementation ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

export type CFIPart = {
  index: number;
  id?: string | undefined;
  offset?: number | undefined;
  temporal?: number | undefined;
  spatial?: number[] | undefined;
  text?: string[] | undefined;
  side?: string | undefined;
};

export type ParsedCFIIndir = CFIPart[][];

type ParsedCFIRange = {
  parent: ParsedCFIIndir;
  start: ParsedCFIIndir;
  end: ParsedCFIIndir;
};

export type ParsedCFI = ParsedCFIIndir | ParsedCFIRange;

const findIndices = <T>(arr: T[], f: (x: T, i: number, a: T[]) => boolean): number[] =>
  arr.map((x, i, a) => (f(x, i, a) ? i : null)).filter((x): x is number => x !== null);

const splitAt = <T>(arr: T[], is: number[]): T[][] =>
  [...is, arr.length].reduce<{ xs: T[][]; a: number }>(
    ({ xs, a }, b) => ({ xs: xs.concat([arr.slice(a + 1, b)]), a: b }),
    { xs: [], a: -1 }
  ).xs;

const concatArrays = <T>(a: T[][], b: T[][]): T[][] => {
  const lastA = a[a.length - 1];
  const firstB = b[0];
  if (!lastA || !firstB) throw new TypeError('concatArrays: cannot concat empty CFI arrays');
  return a.slice(0, -1).concat([lastA.concat(firstB)]).concat(b.slice(1));
};

const isNumber = /\d/;
const isCFI = /^epubcfi\((.*)\)$/;

const escapeCFI = (str: string): string => str.replace(/[\^[\](),;=]/g, '^$&');

const wrap = (x: string): string => (isCFI.test(x) ? x : `epubcfi(${x})`);
const unwrap = (x: string): string => (isCFI.exec(x))?.[1] ?? x;

const lift = (f: (...args: string[]) => string) => (...xs: string[]): string =>
  `epubcfi(${f(...xs.map((x) => (isCFI.exec(x))?.[1] ?? x))})`;

export const joinIndir = lift((...xs: string[]) => xs.join('!'));

type Token = [string, (string | number)?];

const tokenizer = (str: string): Token[] => {
  const tokens: Token[] = [];
  let state: string | null = null;
  let escape = false;
  let value = '';

  const push = (x: Token): void => {
    tokens.push(x);
    state = null;
    value = '';
  };

  const cat = (x: string): void => {
    value += x;
    escape = false;
  };

  for (const char of Array.from(str.trim()).concat('')) {
    if (char === '^' && !escape) {
      escape = true;
      continue;
    }
    if (state === '!') push(['!']);
    else if (state === ',') push([',']);
    else if (state === '/' || state === ':') {
      if (isNumber.test(char)) {
        cat(char);
        continue;
      } else push([state, parseInt(value, 10)]);
    } else if (state === '~') {
      if (isNumber.test(char) || char === '.') {
        cat(char);
        continue;
      } else push(['~', parseFloat(value)]);
    } else if (state === '@') {
      if (char === ':') {
        push(['@', parseFloat(value)]);
        state = '@';
        continue;
      }
      if (isNumber.test(char) || char === '.') {
        cat(char);
        continue;
      } else push(['@', parseFloat(value)]);
    } else if (state === '[') {
      if (char === ';' && !escape) {
        push(['[', value]);
        state = ';';
      } else if (char === ',' && !escape) {
        push(['[', value]);
        state = '[';
      } else if (char === ']' && !escape) push(['[', value]);
      else cat(char);
      continue;
    } else if (state?.startsWith(';')) {
      if (char === '=' && !escape) {
        state = `;${value}`;
        value = '';
      } else if (char === ';' && !escape) {
        push([state, value]);
        state = ';';
      } else if (char === ']' && !escape) push([state, value]);
      else cat(char);
      continue;
    }
    if (
      char === '/' ||
      char === ':' ||
      char === '~' ||
      char === '@' ||
      char === '[' ||
      char === '!' ||
      char === ','
    )
      state = char;
  }
  return tokens;
};

const findTokens = (tokens: Token[], x: string): number[] =>
  findIndices(tokens, ([t]) => t === x);

const parser = (tokens: Token[]): CFIPart[] => {
  const parts: CFIPart[] = [];
  let state: string | null = null;
  for (const [type, val] of tokens) {
    if (type === '/') parts.push({ index: val as number });
    else {
      const last = parts[parts.length - 1];
      if (last) {
        if (type === ':') last.offset = val as number;
        else if (type === '~') last.temporal = val as number;
        else if (type === '@') last.spatial = (last.spatial ?? []).concat(val as number);
        else if (type === ';s') last.side = val as string;
        else if (type === '[') {
          if (state === '/' && val) last.id = val as string;
          else {
            last.text = (last.text ?? []).concat(val as string);
            continue;
          }
        }
      }
    }
    state = type;
  }
  return parts;
};

const parserIndir = (tokens: Token[]): ParsedCFIIndir =>
  splitAt(tokens, findTokens(tokens, '!')).map(parser);

export const parse = (cfi: string): ParsedCFI => {
  const tokens = tokenizer(unwrap(cfi));
  const commas = findTokens(tokens, ',');
  if (!commas.length) return parserIndir(tokens);
  const rangeParts = splitAt(tokens, commas).map(parserIndir);
  const parent = rangeParts[0];
  const start = rangeParts[1];
  const end = rangeParts[2];
  if (!parent || !start || !end || rangeParts.length !== 3) {
    throw new TypeError('Invalid EPUB CFI range');
  }
  return { parent, start, end };
};

const partToString = ({ index, id, offset, temporal, spatial, text, side }: CFIPart): string => {
  const param = side ? `;s=${side}` : '';
  return (
    `/${String(index)}` +
    (id ? `[${escapeCFI(id)}${param}]` : '') +
    (offset != null && index % 2 ? `:${String(offset)}` : '') +
    (temporal ? `~${String(temporal)}` : '') +
    (spatial ? `@${spatial.join(':')}` : '') +
    (text || (!id && side) ? `[${text ? text.map(escapeCFI).join(',') : ''}${param}]` : '')
  );
};

const toInnerString = (parsed: ParsedCFI): string =>
  'parent' in parsed
    ? [parsed.parent, parsed.start, parsed.end].map(toInnerString).join(',')
    : parsed.map((parts) => parts.map(partToString).join('')).join('!');

export const toString = (parsed: ParsedCFI): string => wrap(toInnerString(parsed));

export function collapse(x: string, toEnd?: boolean): string;
export function collapse(x: ParsedCFI, toEnd?: boolean): ParsedCFIIndir;
export function collapse(x: string | ParsedCFI, toEnd?: boolean): string | ParsedCFIIndir {
  if (typeof x === 'string') {
    return toString(collapse(parse(x), toEnd));
  }
  return 'parent' in x ? concatArrays(x.parent, x[toEnd ? 'end' : 'start']) : x;
}

const buildRange = (from: string | ParsedCFIIndir, to: string | ParsedCFIIndir): string => {
  const parsedFrom = collapse(typeof from === 'string' ? parse(from) : from);
  const parsedTo = collapse(typeof to === 'string' ? parse(to) : to, true);

  const localFrom = parsedFrom.at(-1);
  const localTo = parsedTo.at(-1);
  if (!localFrom || !localTo) throw new TypeError('Cannot build a range from an empty CFI');
  const localParent: CFIPart[] = [];
  const localStart: CFIPart[] = [];
  const localEnd: CFIPart[] = [];
  let pushToParent = true;
  const len = Math.max(localFrom.length, localTo.length);

  for (let i = 0; i < len; i++) {
    const a = localFrom[i];
    const b = localTo[i];
    pushToParent = pushToParent && a?.index === b?.index && !a?.offset && !b?.offset;
    if (pushToParent) {
      if (a) localParent.push(a);
    } else {
      if (a) localStart.push(a);
      if (b) localEnd.push(b);
    }
  }

  const parent = parsedFrom.slice(0, -1).concat([localParent]);
  return toString({ parent, start: [localStart], end: [localEnd] });
};

export const compare = (a: string | ParsedCFI, b: string | ParsedCFI): number => {
  const parsedA = typeof a === 'string' ? parse(a) : a;
  const parsedB = typeof b === 'string' ? parse(b) : b;

  if ('start' in parsedA || 'start' in parsedB) {
    return (
      compare(collapse(parsedA), collapse(parsedB)) ||
      compare(collapse(parsedA, true), collapse(parsedB, true))
    );
  }

  const indirA = parsedA;
  const indirB = parsedB;

  for (let i = 0; i < Math.max(indirA.length, indirB.length); i++) {
    const p = indirA[i] ?? [];
    const q = indirB[i] ?? [];
    const maxIndex = Math.max(p.length, q.length) - 1;
    for (let j = 0; j <= maxIndex; j++) {
      const x = p[j];
      const y = q[j];
      if (!x) return -1;
      if (!y) return 1;
      if (x.index > y.index) return 1;
      if (x.index < y.index) return -1;
      if (j === maxIndex) {
        if ((x.offset ?? 0) > (y.offset ?? 0)) return 1;
        if ((x.offset ?? 0) < (y.offset ?? 0)) return -1;
      }
    }
  }
  return 0;
};

const isTextNode = (node: Node): node is Text | CDATASection =>
  node.nodeType === 3 || node.nodeType === 4;
const isElementNode = (node: Node): node is Element => node.nodeType === 1;

type NodeOrChunk = Node | Node[] | string | null;

const isSingleNode = (value: NodeOrChunk): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getChildNodes = (node: Node, filter?: (node: Node) => number): Node[] => {
  const nodes = Array.from(node.childNodes).filter((n) => isTextNode(n) || isElementNode(n));
  if (!filter) return nodes;

  return nodes
    .map((n) => {
      const accept = filter(n);
      if (accept === NodeFilter.FILTER_REJECT) return null;
      if (accept === NodeFilter.FILTER_SKIP) return getChildNodes(n, filter);
      return n;
    })
    .flat()
    .filter((x): x is Node => x !== null);
};

const indexChildNodes = (node: Node, filter?: (node: Node) => number): NodeOrChunk[] => {
  const nodes = getChildNodes(node, filter).reduce<NodeOrChunk[]>((arr, n) => {
    const last = arr[arr.length - 1];
    if (!last) arr.push(n);
    else if (isTextNode(n)) {
      if (Array.isArray(last)) last.push(n);
      else if (isSingleNode(last) && isTextNode(last))
        arr[arr.length - 1] = [last, n];
      else arr.push(n);
    } else {
      if (isSingleNode(last) && isElementNode(last))
        arr.push(null, n);
      else arr.push(n);
    }
    return arr;
  }, []);

  if (nodes.length > 0 && typeof nodes[0] === 'object' && nodes[0] !== null && isElementNode(nodes[0] as Node)) {
    nodes.unshift('first');
  }
  if (
    nodes.length > 0 &&
    typeof nodes[nodes.length - 1] === 'object' &&
    nodes[nodes.length - 1] !== null &&
    isElementNode(nodes[nodes.length - 1] as Node)
  ) {
    nodes.push('last');
  }
  nodes.unshift('before');
  nodes.push('after');
  return nodes;
};

const partsToNode = (
  node: Node | null,
  parts: CFIPart[],
  filter?: (node: Node) => number
): { node: Node; offset?: number; before?: boolean; after?: boolean } => {
  const lastPart = parts[parts.length - 1];
  if (lastPart?.id && node?.ownerDocument) {
    const el = node.ownerDocument.getElementById(lastPart.id);
    if (el) return { node: el, offset: 0 };
  }

  let currentNode: NodeOrChunk = node;

  for (const { index } of parts) {
    const newNode: NodeOrChunk = currentNode && typeof currentNode === 'object' && 'childNodes' in currentNode
      ? indexChildNodes(currentNode, filter)[index] ?? null
      : null;

    if (newNode === 'first' && currentNode && typeof currentNode === 'object' && 'firstChild' in currentNode) {
      return { node: (currentNode).firstChild ?? (currentNode) };
    }
    if (newNode === 'last' && currentNode && typeof currentNode === 'object' && 'lastChild' in currentNode) {
      return { node: (currentNode).lastChild ?? (currentNode) };
    }
    if (newNode === 'before' && currentNode && typeof currentNode === 'object') {
      return { node: currentNode as Node, before: true };
    }
    if (newNode === 'after' && currentNode && typeof currentNode === 'object') {
      return { node: currentNode as Node, after: true };
    }
    currentNode = newNode;
  }

  const offset = lastPart?.offset;
  if (!Array.isArray(currentNode)) {
    const directNode = isSingleNode(currentNode) ? currentNode : node;
    if (!directNode) throw new TypeError('EPUB CFI does not resolve to a document node');
    return offset !== undefined ? { node: directNode, offset } : { node: directNode };
  }

  let sum = 0;
  for (const n of currentNode) {
    const len = (n as Text).nodeValue?.length ?? 0;
    if (offset !== undefined && sum + len >= offset) {
      return { node: n, offset: offset - sum };
    }
    sum += len;
  }

  const firstNode = currentNode[0] ?? node;
  if (!firstNode) throw new TypeError('EPUB CFI resolves to an empty text chunk');
  return offset !== undefined ? { node: firstNode, offset } : { node: firstNode };
};

const nodeToParts = (node: Node, offset: number | null, filter?: (node: Node) => number): CFIPart[] => {
  const elNode = node as Element;
  const id = elNode.id || undefined;
  let parentNode = node.parentNode;

  while (
    filter &&
    parentNode &&
    parentNode !== node.ownerDocument?.documentElement &&
    filter(parentNode) === NodeFilter.FILTER_SKIP
  ) {
    parentNode = parentNode.parentNode;
  }

  if (!parentNode) return [{ index: 0, id, offset: offset ?? undefined }];

  const indexed = indexChildNodes(parentNode, filter);
  const index = indexed.findIndex((x) =>
    Array.isArray(x) ? x.some((item) => item === node) : x === node
  );

  let adjustedOffset = offset;
  const chunk = indexed[index];
  if (Array.isArray(chunk) && offset !== null) {
    let sum = 0;
    for (const x of chunk) {
      if (x === node) {
        sum += offset;
        break;
      } else {
        sum += (x as Text).nodeValue?.length ?? 0;
      }
    }
    adjustedOffset = sum;
  }

  const part: CFIPart = { id, index, offset: adjustedOffset ?? undefined };
  return (
    parentNode !== node.ownerDocument?.documentElement
      ? nodeToParts(parentNode, null, filter).concat(part)
      : [part]
  ).filter((x) => x.index !== -1);
};

export const fromRange = (range: Range, filter?: (node: Node) => number): string => {
  const { startContainer, startOffset, endContainer, endOffset } = range;
  const start = nodeToParts(startContainer, startOffset, filter);
  if (range.collapsed) return toString([start]);
  const end = nodeToParts(endContainer, endOffset, filter);
  return buildRange([start], [end]);
};

export const toRange = (
  doc: Document,
  parts: string | ParsedCFI,
  filter?: (node: Node) => number
): Range => {
  const parsed = typeof parts === 'string' ? parse(parts) : parts;
  const startParts = collapse(parsed);
  const endParts = collapse(parsed, true);

  const root = doc.documentElement;
  // A complete EPUB CFI may include package-document indirections before the
  // content-document path. This resolver operates on the content document, so
  // use the final indirection; local-only CFIs still contain exactly one path.
  const startPath = startParts.at(-1);
  const endPath = endParts.at(-1);
  if (!startPath || !endPath) throw new TypeError('EPUB CFI has no local path');
  const start = partsToNode(root, startPath, filter);
  const end = partsToNode(root, endPath, filter);

  const range = doc.createRange();

  if (start.before) range.setStartBefore(start.node);
  else if (start.after) range.setStartAfter(start.node);
  else range.setStart(start.node, start.offset ?? 0);

  if (end.before) range.setEndBefore(end.node);
  else if (end.after) range.setEndAfter(end.node);
  else range.setEnd(end.node, end.offset ?? 0);

  return range;
};

export const toElement = (
  doc: Document,
  parts: string | ParsedCFI | CFIPart[],
  filter?: (node: Node) => number
): Element | null => {
  const parsed = typeof parts === 'string' ? parse(parts) : parts;
  const path = Array.isArray(parsed) && (parsed.length === 0 || !Array.isArray(parsed[0]))
    ? parsed as CFIPart[]
    : collapse(parsed as ParsedCFI)[0];
  if (!path) return null;
  const resolved = partsToNode(doc.documentElement, path, filter);
  return resolved.node instanceof Element ? resolved.node : resolved.node.parentElement;
};

export const fake = {
  fromIndex: (index: number): string => wrap(`/6/${String((index + 1) * 2)}`),
  toIndex: (parts: ParsedCFIIndir | CFIPart[] | undefined): number => {
    const last = parts?.at(-1);
    const part = Array.isArray(last) ? last.at(-1) : last;
    return (part?.index ?? 0) / 2 - 1;
  },
};
