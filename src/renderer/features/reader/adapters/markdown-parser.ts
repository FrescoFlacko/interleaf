export type MarkdownInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly code: string }
  | { readonly type: 'strong'; readonly children: readonly MarkdownInline[] }
  | { readonly type: 'emphasis'; readonly children: readonly MarkdownInline[] }
  | { readonly type: 'strikethrough'; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: 'link';
      readonly text: string;
      readonly href: string;
      readonly title?: string;
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly type: 'image';
      readonly alt: string;
      readonly src: string;
      readonly title?: string;
    }
  | { readonly type: 'html_text'; readonly raw: string };

type MarkdownListItem = {
  readonly checked?: boolean | null;
  readonly text: string;
  readonly children: readonly MarkdownInline[];
};

type MarkdownBlockList = {
  readonly ordered: boolean;
  readonly start?: number;
  readonly items: readonly MarkdownListItem[];
};

type MarkdownTableCell = {
  readonly text: string;
  readonly children: readonly MarkdownInline[];
  readonly align?: 'left' | 'center' | 'right' | null;
};

type MarkdownTableRow = {
  readonly cells: readonly MarkdownTableCell[];
};

type MarkdownTable = {
  readonly headers: readonly MarkdownTableCell[];
  readonly rows: readonly MarkdownTableRow[];
};

export type MarkdownHeadingBlock = {
  readonly type: 'heading';
  readonly index: number;
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  readonly headingId: string;
  readonly children: readonly MarkdownInline[];
  readonly lineIndex: number;
};

type MarkdownParagraphBlock = {
  readonly type: 'paragraph';
  readonly index: number;
  readonly text: string;
  readonly children: readonly MarkdownInline[];
  readonly lineIndex: number;
};

type MarkdownCodeBlock = {
  readonly type: 'code_block';
  readonly index: number;
  readonly code: string;
  readonly language?: string;
  readonly lineIndex: number;
};

type MarkdownBlockquoteBlock = {
  readonly type: 'blockquote';
  readonly index: number;
  readonly text: string;
  readonly children: readonly MarkdownInline[];
  readonly lineIndex: number;
};

type MarkdownListBlock = {
  readonly type: 'list';
  readonly index: number;
  readonly text: string;
  readonly list: MarkdownBlockList;
  readonly lineIndex: number;
};

type MarkdownTableBlock = {
  readonly type: 'table';
  readonly index: number;
  readonly text: string;
  readonly table: MarkdownTable;
  readonly lineIndex: number;
};

type MarkdownHrBlock = {
  readonly type: 'hr';
  readonly index: number;
  readonly lineIndex: number;
};

export type MarkdownBlock =
  | MarkdownHeadingBlock
  | MarkdownParagraphBlock
  | MarkdownCodeBlock
  | MarkdownBlockquoteBlock
  | MarkdownListBlock
  | MarkdownTableBlock
  | MarkdownHrBlock;

export const MAX_MARKDOWN_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_MARKDOWN_LINE_COUNT = 100_000;
const MAX_MARKDOWN_LINE_LENGTH = 32_768;
const MAX_MARKDOWN_BLOCK_COUNT = 20_000;
const MAX_MARKDOWN_TOTAL_INLINE_NODES = 100_000;
const MAX_MARKDOWN_INLINE_NESTING_DEPTH = 32;

export type ParsedMarkdownDocument = {
  readonly title: string | null;
  readonly blocks: readonly MarkdownBlock[];
  readonly rawText: string;
};

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isSafeMarkdownUrl(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith('#')) return true;
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('mailto:')
  ) {
    return true;
  }
  return false;
}

/**
 * True when a trailing `|` is escaped rather than a row terminator.
 *
 * Only an odd number of preceding backslashes escapes the pipe; `\\|` is an
 * escaped backslash followed by a real terminator.
 */
function endsWithEscapedPipe(row: string): boolean {
  if (!row.endsWith('|')) return false;
  let backslashes = 0;
  for (let idx = row.length - 2; idx >= 0 && row[idx] === '\\'; idx -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Length of the backtick run at `index`, which is at least one. */
function backtickRun(row: string, index: number): number {
  let run = 1;
  while (row[index + run] === '`') run += 1;
  return run;
}

/**
 * Splits a GFM table row on unescaped pipes.
 *
 * A cell may legitimately contain a `|` — a web-article snapshot writes one as
 * `\|` precisely so the character survives without splitting the row — so a
 * plain `split('|')` would shear such a row into the wrong number of columns
 * and shift every later cell under the wrong header. Escaped pipes are
 * unescaped here.
 *
 * Code spans are tracked because they are the one place downstream that takes
 * its content verbatim: inside a code span, backslashes are literal unless they
 * immediately precede an escaped pipe (`\|` or `\\\|`), where they are unescaped
 * to preserve the literal characters without splitting the table row.
 * Ordinary authored Markdown code spans (such as `C:\logs` or `C:\\logs`) retain
 * all backslashes verbatim.
 */
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let index = 0;
  // Length of the run that opened the code span being scanned, 0 when outside
  // one. A span cannot span cells, so this resets at every cell boundary.
  let fence = 0;
  while (index < row.length) {
    const ch = row[index] ?? '';
    if (ch === '`') {
      const run = backtickRun(row, index);
      if (fence === 0) fence = run;
      else if (fence === run) fence = 0;
      current += '`'.repeat(run);
      index += run;
      continue;
    }
    if (fence > 0) {
      if (ch === '\\') {
        const remaining = row.slice(index);
        const match = /^\\+(?=\|)/.exec(remaining);
        if (match) {
          const slashCount = match[0].length;
          const literalSlashes = Math.floor(slashCount / 2);
          if (slashCount % 2 === 1) {
            current += '\\'.repeat(literalSlashes) + '|';
            index += slashCount + 1;
            continue;
          } else {
            current += '\\'.repeat(literalSlashes);
            index += slashCount;
            continue;
          }
        }
      }
      current += ch;
      index += 1;
      continue;
    }
    if (ch === '\\' && index + 1 < row.length) {
      const next = row[index + 1] ?? '';
      if (next === '|') {
        current += next;
        index += 2;
        continue;
      }
      current += ch + next;
      index += 2;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      fence = 0;
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  cells.push(current.trim());
  return cells;
}

function parseLinkTarget(
  text: string,
  startIdx: number
): { readonly href: string; readonly title?: string; readonly endIdx: number } | null {
  let parenDepth = 1;
  let idx = startIdx + 1;
  let inQuotes = false;
  let quoteChar = '';

  while (idx < text.length && parenDepth > 0) {
    const ch = text[idx];
    if (inQuotes) {
      if (ch === quoteChar && text[idx - 1] !== '\\') {
        inQuotes = false;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
    idx++;
  }

  if (parenDepth === 0) {
    const rawTarget = text.slice(startIdx + 1, idx).trim();
    const targetParts = /^(\S+)(?:\s+["'](.*?)["'])?$/.exec(rawTarget);
    return {
      href: targetParts ? targetParts[1] ?? rawTarget : rawTarget,
      ...(targetParts?.[2] !== undefined ? { title: targetParts[2] } : {}),
      endIdx: idx,
    };
  }
  return null;
}

export function parseMarkdownInlines(
  text: string,
  depth = 0,
  budget?: { totalNodes: number }
): readonly MarkdownInline[] {
  if (
    depth >= MAX_MARKDOWN_INLINE_NESTING_DEPTH ||
    (budget !== undefined && budget.totalNodes >= MAX_MARKDOWN_TOTAL_INLINE_NODES)
  ) {
    return [{ type: 'text', text: text.slice(0, MAX_MARKDOWN_LINE_LENGTH) }];
  }

  const inlines: MarkdownInline[] = [];
  let index = 0;
  const safeText = text.length > MAX_MARKDOWN_LINE_LENGTH ? text.slice(0, MAX_MARKDOWN_LINE_LENGTH) : text;

  const addInline = (node: MarkdownInline): void => {
    if (budget !== undefined) budget.totalNodes += 1;
    inlines.push(node);
  };

  while (index < safeText.length) {
    // 1. Escaped character
    if (safeText[index] === '\\' && index + 1 < safeText.length) {
      addInline({ type: 'text', text: safeText[index + 1] ?? '' });
      index += 2;
      continue;
    }

    // 2. Inline Code: `...` or ``...``
    if (safeText[index] === '`') {
      let tickCount = 1;
      while (index + tickCount < safeText.length && safeText[index + tickCount] === '`') {
        tickCount++;
      }
      const tickStr = '`'.repeat(tickCount);
      const closeIdx = safeText.indexOf(tickStr, index + tickCount);
      if (closeIdx !== -1) {
        const codeContent = safeText.slice(index + tickCount, closeIdx);
        addInline({ type: 'code', code: codeContent });
        index = closeIdx + tickCount;
        continue;
      }
    }

    // 3. Strikethrough: ~~...~~
    if (safeText.startsWith('~~', index)) {
      const closeIdx = safeText.indexOf('~~', index + 2);
      if (closeIdx !== -1) {
        const content = safeText.slice(index + 2, closeIdx);
        addInline({
          type: 'strikethrough',
          children: parseMarkdownInlines(content, depth + 1, budget),
        });
        index = closeIdx + 2;
        continue;
      }
    }

    // 4. Strong & Emphasis: ***...***, **...**, *...*, ___...___, __...__, _..._
    if (safeText.startsWith('***', index) || safeText.startsWith('___', index)) {
      const marker = safeText.slice(index, index + 3);
      const closeIdx = safeText.indexOf(marker, index + 3);
      if (closeIdx !== -1) {
        const content = safeText.slice(index + 3, closeIdx);
        addInline({
          type: 'strong',
          children: [{ type: 'emphasis', children: parseMarkdownInlines(content, depth + 2, budget) }],
        });
        index = closeIdx + 3;
        continue;
      }
    }

    if (safeText.startsWith('**', index) || safeText.startsWith('__', index)) {
      const marker = safeText.slice(index, index + 2);
      const closeIdx = safeText.indexOf(marker, index + 2);
      if (closeIdx !== -1) {
        const content = safeText.slice(index + 2, closeIdx);
        addInline({
          type: 'strong',
          children: parseMarkdownInlines(content, depth + 1, budget),
        });
        index = closeIdx + 2;
        continue;
      }
    }

    if (safeText.startsWith('*', index) || safeText.startsWith('_', index)) {
      const marker = safeText[index] ?? '*';
      const closeIdx = safeText.indexOf(marker, index + 1);
      if (closeIdx !== -1 && closeIdx > index + 1 && !/\s/u.test(safeText[index + 1] ?? '')) {
        const content = safeText.slice(index + 1, closeIdx);
        addInline({
          type: 'emphasis',
          children: parseMarkdownInlines(content, depth + 1, budget),
        });
        index = closeIdx + 1;
        continue;
      }
    }

    // 5. Images: ![alt](url "title")
    if (safeText.startsWith('![', index)) {
      const closeBracket = safeText.indexOf(']', index + 2);
      if (closeBracket !== -1 && safeText[closeBracket + 1] === '(') {
        const parsedTarget = parseLinkTarget(safeText, closeBracket + 1);
        if (parsedTarget !== null) {
          const alt = safeText.slice(index + 2, closeBracket);
          addInline({
            type: 'image',
            alt,
            src: parsedTarget.href,
            ...(parsedTarget.title !== undefined ? { title: parsedTarget.title } : {}),
          });
          index = parsedTarget.endIdx + 1;
          continue;
        }
      }
    }

    // 6. Links: [text](url "title")
    if (safeText[index] === '[') {
      const closeBracket = safeText.indexOf(']', index + 1);
      if (closeBracket !== -1 && safeText[closeBracket + 1] === '(') {
        const parsedTarget = parseLinkTarget(safeText, closeBracket + 1);
        if (parsedTarget !== null) {
          const linkText = safeText.slice(index + 1, closeBracket);
          addInline({
            type: 'link',
            text: linkText,
            href: parsedTarget.href,
            ...(parsedTarget.title !== undefined ? { title: parsedTarget.title } : {}),
            children: parseMarkdownInlines(linkText, depth + 1, budget),
          });
          index = parsedTarget.endIdx + 1;
          continue;
        }
      }
    }

    // 7. Autolinks: <https://...> or <mailto:...>
    const autolinkMatch = /^<((?:https?:\/\/|mailto:)[^>]+)>/i.exec(safeText.slice(index));
    if (autolinkMatch?.[1]) {
      const href = autolinkMatch[1];
      addInline({
        type: 'link',
        text: href,
        href,
        children: [{ type: 'text', text: href }],
      });
      index += autolinkMatch[0].length;
      continue;
    }

    // 8. Raw HTML tag (e.g. <script>...</script> or <div class="...">)
    const htmlTagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?:\s+[^>]*?)?\/?>/i.exec(safeText.slice(index));
    if (htmlTagMatch?.[0]) {
      addInline({
        type: 'html_text',
        raw: htmlTagMatch[0],
      });
      index += htmlTagMatch[0].length;
      continue;
    }

    // 9. Regular text chunk
    let nextSpecial = index + 1;
    while (
      nextSpecial < safeText.length &&
      safeText[nextSpecial] !== '\\' &&
      safeText[nextSpecial] !== '`' &&
      safeText[nextSpecial] !== '*' &&
      safeText[nextSpecial] !== '_' &&
      safeText[nextSpecial] !== '~' &&
      safeText[nextSpecial] !== '[' &&
      safeText[nextSpecial] !== '!' &&
      safeText[nextSpecial] !== '<'
    ) {
      nextSpecial++;
    }

    addInline({
      type: 'text',
      text: safeText.slice(index, nextSpecial),
    });
    index = nextSpecial;
  }

  return inlines;
}

export function parseMarkdownDocument(markdownText: string): ParsedMarkdownDocument {
  if (markdownText.length > MAX_MARKDOWN_DOCUMENT_BYTES) {
    throw new Error(
      `Markdown document exceeds maximum supported size of ${String(MAX_MARKDOWN_DOCUMENT_BYTES / (1024 * 1024))} MB.`
    );
  }

  // Strip BOM if present
  let text = markdownText.charCodeAt(0) === 0xFEFF ? markdownText.slice(1) : markdownText;
  // Normalize line breaks
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = text.split('\n');
  if (lines.length > MAX_MARKDOWN_LINE_COUNT) {
    throw new Error(
      `Markdown document exceeds maximum line count limit of ${String(MAX_MARKDOWN_LINE_COUNT)} lines.`
    );
  }
  let currentLineIndex = 0;
  let title: string | null = null;
  const inlineBudget = { totalNodes: 0 };
  if (lines[0]?.trim() === '---') {
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      const trimmedLine = lines[i]?.trim();
      if (trimmedLine === '---' || trimmedLine === '...') {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      const frontmatterLines = lines.slice(1, endIdx);
      const hasFrontmatterKeys = frontmatterLines.some((l) => /^[a-zA-Z0-9_-]+:\s*/.test(l.trim()));
      if (hasFrontmatterKeys) {
        for (const fLine of frontmatterLines) {
          const match = /^title:\s*["']?(.*?)["']?$/i.exec(fLine.trim());
          if (match?.[1]) {
            title = match[1].trim();
          }
        }
        currentLineIndex = endIdx + 1;
      }
    }
  }

  const blocks: MarkdownBlock[] = [];
  let blockIndex = 0;
  const headingCounts = new Map<string, number>();

  while (currentLineIndex < lines.length) {
    if (blocks.length >= MAX_MARKDOWN_BLOCK_COUNT) {
      throw new Error(
        `Markdown document exceeds maximum block count limit of ${String(MAX_MARKDOWN_BLOCK_COUNT)} blocks.`
      );
    }

    const line = lines[currentLineIndex] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      currentLineIndex++;
      continue;
    }
    // 1. Fenced Code Block: ``` or ~~~
    const fenceMatch = /^(```+|~~~+)(.*)$/.exec(trimmed);
    if (fenceMatch?.[1]) {
      const fenceChar = fenceMatch[1][0] ?? '`';
      const fenceLen = fenceMatch[1].length;
      const rawLang = fenceMatch[2]?.trim().split(/\s+/)[0];
      const language = rawLang !== undefined && rawLang.length > 0 ? rawLang : undefined;
      const codeLines: string[] = [];
      const startLine = currentLineIndex;
      currentLineIndex++;

      while (currentLineIndex < lines.length) {
        const nextLine = lines[currentLineIndex] ?? '';
        const closeMatch = new RegExp(`^\\s*\\${fenceChar}{${String(fenceLen)},}\\s*$`).exec(nextLine);
        if (closeMatch) {
          currentLineIndex++;
          break;
        }
        codeLines.push(nextLine);
        currentLineIndex++;
      }

      blocks.push({
        type: 'code_block',
        index: blockIndex++,
        code: codeLines.join('\n'),
        ...(language !== undefined && language.length > 0 ? { language } : {}),
        lineIndex: startLine,
      });
      continue;
    }

    // 2. ATX Heading: # to ######
    const headingMatch = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(trimmed);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const headingRaw = headingMatch[2].trim();
      const baseSlug = slugifyHeading(headingRaw) || `heading-${String(blockIndex)}`;
      const count = (headingCounts.get(baseSlug) ?? 0) + 1;
      headingCounts.set(baseSlug, count);
      const headingId = count === 1 ? baseSlug : `${baseSlug}-${String(count)}`;

      if (!title && level === 1) {
        title = headingRaw;
      }

      blocks.push({
        type: 'heading',
        index: blockIndex++,
        level,
        text: headingRaw,
        headingId,
        children: parseMarkdownInlines(headingRaw, 0, inlineBudget),
        lineIndex: currentLineIndex,
      });
      currentLineIndex++;
      continue;
    }

    // 2b. Setext Heading: Text line followed by === (H1) or --- (H2)
    if (currentLineIndex + 1 < lines.length) {
      const nextLine = (lines[currentLineIndex + 1] ?? '').trim();
      const isSetextH1 = /^={1,}\s*$/.test(nextLine);
      const isSetextH2 = /^-{1,}\s*$/.test(nextLine);
      if (
        (isSetextH1 || isSetextH2) &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('```') &&
        !trimmed.startsWith('~~~') &&
        !trimmed.startsWith('>') &&
        !/^(?:[*_-]\s*){3,}$/.test(trimmed)
      ) {
        const level: 1 | 2 = isSetextH1 ? 1 : 2;
        const headingRaw = trimmed;
        const baseSlug = slugifyHeading(headingRaw) || `heading-${String(blockIndex)}`;
        const count = (headingCounts.get(baseSlug) ?? 0) + 1;
        headingCounts.set(baseSlug, count);
        const headingId = count === 1 ? baseSlug : `${baseSlug}-${String(count)}`;

        if (!title && level === 1) {
          title = headingRaw;
        }

        blocks.push({
          type: 'heading',
          index: blockIndex++,
          level,
          text: headingRaw,
          headingId,
          children: parseMarkdownInlines(headingRaw, 0, inlineBudget),
          lineIndex: currentLineIndex,
        });
        currentLineIndex += 2;
        continue;
      }
    }
    // 3. Horizontal Rule: ---, ***, ___
    if (/^(?:[*_-]\s*){3,}$/.test(trimmed)) {
      blocks.push({
        type: 'hr',
        index: blockIndex++,
        lineIndex: currentLineIndex,
      });
      currentLineIndex++;
      continue;
    }

    // 4. Blockquote: > ...
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      const startLine = currentLineIndex;
      while (
        currentLineIndex < lines.length &&
        ((lines[currentLineIndex] ?? '').trim().startsWith('>') ||
          ((lines[currentLineIndex] ?? '').trim() !== '' && !(lines[currentLineIndex] ?? '').trim().startsWith('#')))
      ) {
        const cur = lines[currentLineIndex] ?? '';
        if (cur.trim().startsWith('>')) {
          quoteLines.push(cur.replace(/^\s*>\s?/, ''));
        } else {
          quoteLines.push(cur);
        }
        currentLineIndex++;
      }
      const quoteText = quoteLines.join('\n');
      blocks.push({
        type: 'blockquote',
        index: blockIndex++,
        text: quoteText,
        children: parseMarkdownInlines(quoteText, 0, inlineBudget),
        lineIndex: startLine,
      });
      continue;
    }

    // 5. Table: GFM Pipe table
    if (
      trimmed.includes('|') &&
      currentLineIndex + 1 < lines.length &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test((lines[currentLineIndex + 1] ?? '').trim())
    ) {
      const startLine = currentLineIndex;
      const parseRow = (r: string): string[] => {
        let clean = r.trim();
        if (clean.startsWith('|')) clean = clean.slice(1);
        if (clean.endsWith('|') && !endsWithEscapedPipe(clean)) clean = clean.slice(0, -1);
        return splitTableRow(clean);
      };

      const headerRawCells = parseRow(lines[currentLineIndex] ?? '');
      const alignCells = parseRow(lines[currentLineIndex + 1] ?? '').map((a) => {
        const left = a.startsWith(':');
        const right = a.endsWith(':');
        if (left && right) return 'center' as const;
        if (right) return 'right' as const;
        if (left) return 'left' as const;
        return null;
      });
      currentLineIndex += 2;

      const rows: MarkdownTableRow[] = [];
      const tableLines: string[] = [headerRawCells.join(' | ')];

      while (
        currentLineIndex < lines.length &&
        (lines[currentLineIndex] ?? '').trim() !== '' &&
        (lines[currentLineIndex] ?? '').trim().includes('|')
      ) {
        const rowRawCells = parseRow(lines[currentLineIndex] ?? '');
        tableLines.push(rowRawCells.join(' | '));
        const cells: MarkdownTableCell[] = rowRawCells.map((cellText, i) => ({
          text: cellText,
          children: parseMarkdownInlines(cellText, 0, inlineBudget),
          align: alignCells[i] ?? null,
        }));
        rows.push({ cells });
        currentLineIndex++;
      }

      const headers: MarkdownTableCell[] = headerRawCells.map((cellText, i) => ({
        text: cellText,
        children: parseMarkdownInlines(cellText, 0, inlineBudget),
        align: alignCells[i] ?? null,
      }));
      blocks.push({
        type: 'table',
        index: blockIndex++,
        text: tableLines.join('\n'),
        table: {
          headers,
          rows,
        },
        lineIndex: startLine,
      });
      continue;
    }

    // 6. List (ordered or unordered or task list)
    const listMatch = /^(\s*)(?:([*+-])|(\d+)\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const isOrdered = Boolean(listMatch[3]);
      const startLine = currentLineIndex;
      const items: MarkdownListItem[] = [];

      while (currentLineIndex < lines.length) {
        const currentL = lines[currentLineIndex] ?? '';
        const itemMatch = /^(\s*)(?:([*+-])|(\d+)\.)\s+(.*)$/.exec(currentL);
        if (itemMatch?.[4] !== undefined) {
          let itemText = itemMatch[4];
          let checked: boolean | null = null;
          const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
          if (taskMatch?.[1] && taskMatch[2] !== undefined) {
            checked = taskMatch[1].toLowerCase() === 'x';
            itemText = taskMatch[2];
          }
          items.push({
            text: itemText,
            ...(checked !== null ? { checked } : {}),
            children: parseMarkdownInlines(itemText, 0, inlineBudget),
          });
          currentLineIndex++;
        } else if (currentL.trim() === '') {
          break;
        } else if (/^\s{2,}/.test(currentL)) {
          // Continuation line
          const lastItem = items[items.length - 1];
          if (lastItem) {
            const updatedText = `${lastItem.text} ${currentL.trim()}`;
            items[items.length - 1] = {
              text: updatedText,
              ...(lastItem.checked !== undefined && lastItem.checked !== null
                ? { checked: lastItem.checked }
                : {}),
              children: parseMarkdownInlines(updatedText, 0, inlineBudget),
            };
          }
          currentLineIndex++;
        } else {
          break;
        }
      }

      blocks.push({
        type: 'list',
        index: blockIndex++,
        text: items.map((it) => it.text).join('\n'),
        list: {
          ordered: isOrdered,
          items,
        },
        lineIndex: startLine,
      });
      continue;
    }

    // 7. Paragraph
    const paraLines = [trimmed];
    const startLine = currentLineIndex;
    currentLineIndex++;

    while (currentLineIndex < lines.length) {
      const nextLine = lines[currentLineIndex] ?? '';
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed === '') break;
      // Check if nextLine starts a new block
      const isNextSetext =
        currentLineIndex + 1 < lines.length &&
        (/^={1,}\s*$/.test((lines[currentLineIndex + 1] ?? '').trim()) ||
          /^-{1,}\s*$/.test((lines[currentLineIndex + 1] ?? '').trim()));
      if (
        isNextSetext ||
        /^(?:#{1,6}\s+|```+|~~~+|>|(?:\s*[*+-]|\s*\d+\.)\s+|(?:[*_-]\s*){3,}$)/.test(nextTrimmed) ||
        (nextTrimmed.includes('|') &&
          currentLineIndex + 1 < lines.length &&
          /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test((lines[currentLineIndex + 1] ?? '').trim()))
      ) {
        break;
      }
      paraLines.push(nextTrimmed);
      currentLineIndex++;
    }

    const paraText = paraLines.join(' ');
    blocks.push({
      type: 'paragraph',
      index: blockIndex++,
      text: paraText,
      children: parseMarkdownInlines(paraText, 0, inlineBudget),
      lineIndex: startLine,
    });
  }

  return {
    title: title ?? (blocks[0]?.type === 'heading' ? blocks[0].text : null),
    blocks,
    rawText: markdownText,
  };
}
