// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FolderTree } from '@shared/types/document';
import { FolderTreeItem } from '../../src/renderer/features/library/components/FolderTreeItem';
import { ImportDropzone } from '../../src/renderer/features/library/components/ImportDropzone';
import { TodoListActivityItem } from '../../src/renderer/features/agent/AgentActivityItems';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The renderer's chrome speaks in icons, not in characters borrowed from the
 * font. An emoji or a box-drawing glyph pressed into service as an icon paints
 * in the font's own colours, so it ignores every theme, and it is announced as
 * whatever the platform decides that character is called. This suite is the
 * standing check that none are left, and that the icons that replaced them
 * carry names where the icon is the only thing saying what happened.
 */

// Vitest runs from the repository root, and the jsdom environment does not
// give this module a file URL to resolve against.
const RENDERER = path.resolve(process.cwd(), 'src/renderer');

/**
 * Emoji, dingbats, arrows, and the geometric/box shapes that were being used
 * as icons. Ordinary typography — a bullet, an en dash, a real minus sign in a
 * number — is not in scope and is not matched.
 */
const GLYPH_PATTERN =
  /[\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}]/u;

/** Strips whole-line comments so documentation prose is not swept as markup. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const FOLDER: FolderTree = {
  id: 'folder-sweep',
  name: 'Papers',
  parentId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  children: [
    {
      id: 'folder-sweep-child',
      name: 'Nested',
      parentId: 'folder-sweep',
          createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      children: [],
      documentCount: 0,
    },
  ],
  documentCount: 2,
};

function appIcons(root: HTMLElement): SVGElement[] {
  return [...root.querySelectorAll<SVGElement>('svg[data-icon]')];
}

describe('renderer chrome carries no text glyphs used as icons', () => {
  beforeEach(() => {
    cleanup();
    stubBridge({ library: {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test('no component renders an emoji or symbol character as an icon', () => {
    const files = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      entry.endsWith('.tsx')
    );
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(path.join(RENDERER, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isComment(line) || !GLYPH_PATTERN.test(line)) return;
        offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test('the folder tree draws its disclosure, folder, and row actions as icons', () => {
    const { container } = render(
      <ul>
        <FolderTreeItem
          node={FOLDER}
          selectedFolderId={null}
          onSelect={vi.fn()}
          onNewSubfolder={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onDropDocument={vi.fn()}
        />
      </ul>
    );

    const names = appIcons(container).map((icon) => icon.getAttribute('data-icon'));
    expect(names).toEqual(
      expect.arrayContaining(['disclosure-expanded', 'folder', 'folder-add', 'rename', 'delete'])
    );

    // Each row action is still reachable and named by the control, not the glyph.
    expect(screen.getByRole('button', { name: 'Add subfolder to Papers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename Papers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Papers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse folder' })).toBeTruthy();
    for (const icon of appIcons(container)) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('the import dropzone states are icons that follow the theme', () => {
    const { container, rerender } = render(
      <ImportDropzone
        onImportDroppedFiles={vi.fn()}
        onOpenFileDialog={vi.fn()}
        isImporting={false}
        onImportFromWeb={vi.fn()}
      />
    );
    expect(appIcons(container).map((i) => i.getAttribute('data-icon'))).toContain('library-empty');

    rerender(
      <ImportDropzone onImportDroppedFiles={vi.fn()} onOpenFileDialog={vi.fn()} isImporting onImportFromWeb={vi.fn()} />
    );
    expect(appIcons(container).map((i) => i.getAttribute('data-icon'))).toContain('busy');
    // The heading beside the glyph already says which state this is.
    for (const icon of appIcons(container)) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon.getAttribute('color')).toBe('currentColor');
    }
  });

  /**
   * A checklist mark is the only thing that reports where a step stands, so
   * unlike a decorative glyph it must be announced.
   */
  test('agent checklist status icons carry their own text equivalent', () => {
    render(
      <TodoListActivityItem
        activity={{
          kind: 'todo_list',
          id: 'todos-1',
          todos: [
            { task: 'Read the brief', status: 'completed' },
            { task: 'Write the patch', status: 'in_progress' },
            { task: 'Run the checks', status: 'pending' },
            { task: 'Ship it', status: 'failed' },
          ],
        }}
      />
    );

    for (const name of ['Completed', 'In progress', 'Pending', 'Failed']) {
      expect(screen.getByRole('img', { name })).toBeTruthy();
    }
  });
});
