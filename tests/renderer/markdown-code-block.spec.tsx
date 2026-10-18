// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MarkdownCodeBlock } from '../../src/renderer/components/markdown/MarkdownCodeBlock';
import { parseCodeFenceInfo } from '../../src/renderer/components/markdown/code-fence-info';
import { MarkdownContent } from '../../src/renderer/components/markdown/MarkdownContent';
import { stubBridge } from '../helpers/interleaf-api';

type ClipboardResult = { readonly copied: boolean; readonly characterCount: number };

let writeText: Mock;

/** A clipboard write the test settles by hand, to control arrival order. */
function deferredWrite(): { promise: Promise<ClipboardResult>; settle: (copied: boolean) => void } {
  let settle: (copied: boolean) => void = () => undefined;
  const promise = new Promise<ClipboardResult>((resolve) => {
    settle = (copied) => { resolve({ copied, characterCount: copied ? 1 : 0 }); };
  });
  return { promise, settle };
}

describe('parseCodeFenceInfo', () => {
  it('reports the language the fence declared', () => {
    expect(parseCodeFenceInfo('ts')).toEqual({ language: 'ts', filename: null });
    expect(parseCodeFenceInfo('  TypeScript  ')).toEqual({ language: 'typescript', filename: null });
    expect(parseCodeFenceInfo('objective-c')).toEqual({ language: 'objective-c', filename: null });
  });

  it('falls back to a neutral label instead of claiming a language', () => {
    expect(parseCodeFenceInfo('')).toEqual({ language: 'code', filename: null });
    expect(parseCodeFenceInfo('   ')).toEqual({ language: 'code', filename: null });
    expect(parseCodeFenceInfo('!!!')).toEqual({ language: 'code', filename: null });
  });

  it('shows a filename only where the metadata supplies one', () => {
    expect(parseCodeFenceInfo('ts src/app.ts')).toEqual({ language: 'ts', filename: 'src/app.ts' });
    expect(parseCodeFenceInfo('ts title="src/app.ts"')).toEqual({ language: 'ts', filename: 'src/app.ts' });
    expect(parseCodeFenceInfo('ts filename=notes.md')).toEqual({ language: 'ts', filename: 'notes.md' });
    expect(parseCodeFenceInfo('src/app.ts')).toEqual({ language: 'code', filename: 'src/app.ts' });
    expect(parseCodeFenceInfo('ts some prose here')).toEqual({ language: 'ts', filename: null });
  });

  it('keeps a quoted filename whole, spaces and escapes included', () => {
    expect(parseCodeFenceInfo('ts title="src/my app.ts"')).toEqual({
      language: 'ts',
      filename: 'src/my app.ts',
    });
    expect(parseCodeFenceInfo('ts file="a b c.ts"')).toEqual({ language: 'ts', filename: 'a b c.ts' });
    expect(parseCodeFenceInfo('ts title="src/\\"odd\\" name.ts"')).toEqual({
      language: 'ts',
      filename: 'src/"odd" name.ts',
    });
    expect(parseCodeFenceInfo('ts title="src\\\\app.ts"')).toEqual({
      language: 'ts',
      filename: 'src\\app.ts',
    });
  });

  it('reads a filename past other fence attributes', () => {
    expect(parseCodeFenceInfo('ts showLineNumbers title="src/my app.ts" {1,3}')).toEqual({
      language: 'ts',
      filename: 'src/my app.ts',
    });
    expect(parseCodeFenceInfo('ts {1,3} src/app.ts')).toEqual({ language: 'ts', filename: 'src/app.ts' });
  });

  it('shows no filename rather than a truncated or invented one', () => {
    // An unbalanced quote is rejected outright: no “src/my” fragment appears.
    expect(parseCodeFenceInfo('ts title="src/my app.ts')).toEqual({ language: 'ts', filename: null });
    expect(parseCodeFenceInfo('ts title="')).toEqual({ language: 'ts', filename: null });
    expect(parseCodeFenceInfo('title="src/app.ts')).toEqual({ language: 'code', filename: null });
    expect(parseCodeFenceInfo('ts title="unterminated \\"')).toEqual({ language: 'ts', filename: null });
    // A quoted first word is metadata, not a language claim.
    expect(parseCodeFenceInfo('"ts"')).toEqual({ language: 'code', filename: null });
    expect(parseCodeFenceInfo('ts run the linter first')).toEqual({ language: 'ts', filename: null });
  });

  it('bounds untrusted metadata', () => {
    const long = `${'a'.repeat(400)}.ts`;
    const parsed = parseCodeFenceInfo(`ts ${long}`);
    expect(parsed.filename?.length).toBeLessThanOrEqual(64);
    expect(parseCodeFenceInfo('a'.repeat(400)).language).toBe('code');
    expect(parseCodeFenceInfo(`ts title="${'b'.repeat(400)}.ts"`).filename?.length).toBeLessThanOrEqual(64);
    expect(parseCodeFenceInfo(`ts ${'word '.repeat(200)}src/app.ts`).filename).toBeNull();
  });
});

describe('MarkdownCodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.fn(() => Promise.resolve({ copied: true, characterCount: 4 }));
    stubBridge({ clipboard: { writeText } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a header with the language, an icon and the declared filename', async () => {
    const { container } = render(<MarkdownCodeBlock code="const a = 1;" info='ts title="src/app.ts"' />);

    expect(screen.getByTestId('markdown-code-header')).toBeTruthy();
    expect(screen.getByTestId('markdown-code-language')).toHaveTextContent('ts');
    expect(screen.getByTestId('markdown-code-filename')).toHaveTextContent('src/app.ts');
    expect(screen.getByTestId('markdown-code-header').querySelector('svg')).not.toBeNull();
    expect(screen.getByText('const a = 1;').tagName).toBe('CODE');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('omits the filename when the fence declares none', () => {
    render(<MarkdownCodeBlock code="print(1)" info="python" />);
    expect(screen.getByTestId('markdown-code-language')).toHaveTextContent('python');
    expect(screen.queryByTestId('markdown-code-filename')).toBeNull();
  });

  it('gives the copy control an accessible name and a visible focus state', () => {
    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');
    expect(button).toHaveAccessibleName('Copy code');
    expect(button.className).toContain('focus:ring-2');
    expect(button.className).toContain('focus:ring-focus-ring');
  });

  it('shows a success state for about a second, then returns to idle', async () => {
    vi.useFakeTimers();
    render(<MarkdownCodeBlock code="copy me" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(button).toHaveAccessibleName('Code copied to the clipboard');
    expect(screen.getByTestId('markdown-copy-status')).toHaveTextContent('Code copied to the clipboard.');

    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(button.getAttribute('data-copy-state')).toBe('idle');
    expect(screen.getByTestId('markdown-copy-status')).toHaveTextContent('');
  });

  it('reports a failed copy truthfully instead of showing success', async () => {
    writeText.mockResolvedValue({ copied: false, characterCount: 0 });
    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    await waitFor(() => { expect(button.getAttribute('data-copy-state')).toBe('failed'); });
    expect(button).toHaveAccessibleName('Copy failed. Try again.');
    expect(screen.getByTestId('markdown-copy-status')).toHaveTextContent('Copying the code failed.');
  });

  it('reports a rejected clipboard bridge as a failure', async () => {
    writeText.mockRejectedValue(new Error('clipboard unavailable'));
    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    await waitFor(() => { expect(button.getAttribute('data-copy-state')).toBe('failed'); });
  });

  it('does not leave a timer running after unmount or a repeated click', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    // A second click while the success state is up replaces the pending timer
    // rather than leaving the first one to fire later.
    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(clearSpy).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(vi.getTimerCount()).toBe(0);
    clearSpy.mockRestore();
  });

  it('never reports an older success once a newer attempt has failed', async () => {
    const first = deferredWrite();
    const second = deferredWrite();
    writeText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(2);

    await act(async () => { second.settle(false); await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('failed');

    // The first write succeeds, but it is no longer the attempt on screen.
    await act(async () => { first.settle(true); await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('failed');
    expect(screen.getByTestId('markdown-copy-status')).toHaveTextContent('Copying the code failed.');
  });

  it('never reports an older failure once a newer attempt has succeeded', async () => {
    const first = deferredWrite();
    const second = deferredWrite();
    writeText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    fireEvent.click(button);

    await act(async () => { second.settle(true); await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');

    await act(async () => { first.settle(false); await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    expect(screen.getByTestId('markdown-copy-status')).toHaveTextContent('Code copied to the clipboard.');
  });

  it('shows the pending attempt as idle rather than a stale success', async () => {
    const second = deferredWrite();
    writeText
      .mockImplementationOnce(() => Promise.resolve({ copied: true, characterCount: 1 }))
      .mockImplementationOnce(() => second.promise);

    render(<MarkdownCodeBlock code="x" info="ts" />);
    const button = screen.getByTestId('markdown-copy-code');

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');

    // Pressing again clears the previous result while the new write is in flight.
    fireEvent.click(button);
    expect(button.getAttribute('data-copy-state')).toBe('idle');

    await act(async () => { second.settle(true); await Promise.resolve(); });
    expect(button.getAttribute('data-copy-state')).toBe('copied');
  });

  it('settles a write that lands after unmount without touching state or timers', async () => {
    vi.useFakeTimers();
    const pending = deferredWrite();
    writeText.mockImplementationOnce(() => pending.promise);

    const { unmount } = render(<MarkdownCodeBlock code="x" info="ts" />);
    fireEvent.click(screen.getByTestId('markdown-copy-code'));
    unmount();

    await act(async () => { pending.settle(true); await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Markdown rendering around the code block', () => {
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve({ copied: true, characterCount: 1 }));
    stubBridge({ clipboard: { writeText } });
  });

  afterEach(() => {
    cleanup();
  });

  it('gives fenced code a header while leaving inline code untouched', () => {
    render(<MarkdownContent content={'Use `npm run lint` first.\n\n```ts src/app.ts\nconst a = 1;\n```'} />);

    expect(screen.getByTestId('markdown-code-header')).toBeTruthy();
    expect(screen.getByTestId('markdown-code-filename')).toHaveTextContent('src/app.ts');

    const inline = screen.getByText('npm run lint');
    expect(inline.tagName).toBe('CODE');
    expect(inline.closest('[data-testid="markdown-code-header"]')).toBeNull();
    expect(inline.closest('pre')).toBeNull();
  });

  it('still renders raw HTML in Markdown as text, not markup', () => {
    const { container } = render(
      <MarkdownContent content={'<img src=x onerror="alert(1)">\n\n```html\n<script>alert(1)</script>\n```'} />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
