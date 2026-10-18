// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DocumentFormat } from '@shared/types/document';
import type { Annotation } from '@shared/types/annotation';
import { createDocumentAdapter } from '../../src/renderer/features/reader/adapters/adapter-factory';
import { testDocumentAdapter } from '../helpers/document-adapter';

/**
 * The shared adapter double must not let a component test reach a state the
 * reader never can. Each format's double is compared against the real adapter
 * the factory builds for that format.
 */

const FORMATS = ['pdf', 'markdown', 'docx', 'pptx', 'epub', 'mobi'] as const satisfies readonly DocumentFormat[];

describe('test document adapter double', () => {
  it.each(FORMATS)('grants a %s double exactly the capabilities of the real adapter', (format) => {
    const real = createDocumentAdapter(format);
    const double = testDocumentAdapter(format);

    expect(double.format).toBe(format);
    expect(double.capabilities.reflow === null).toBe(real.capabilities.reflow === null);
    expect(double.capabilities.externalLinks === null).toBe(real.capabilities.externalLinks === null);
  });

  it('answers the capability calls the reader makes on mount the way production does', async () => {
    const markdown = testDocumentAdapter('markdown');
    expect(markdown.capabilities.externalLinks?.setExternalLinkCallback(() => undefined)).toBeUndefined();
    await expect(
      markdown.capabilities.reflow?.setReflowOptions({
        lineHeight: 1.6,
        horizontalMarginRem: 2,
        fontSize: 18,
        fontFamily: 'serif',
        contentWidth: 720,
        paragraphSpacing: 1,
      })
    ).resolves.toBeUndefined();
  });

  it('resolves setAnnotations to anchor results rather than undefined', async () => {
    const annotations: readonly Annotation[] = [];
    await expect(testDocumentAdapter('pdf').setAnnotations(annotations)).resolves.toEqual([]);
  });

  it('routes a stub to the capability the format really has', () => {
    const calls: string[] = [];
    const pdf = testDocumentAdapter('pdf', {}, { setExternalLinkCallback: () => void calls.push('links') });
    pdf.capabilities.externalLinks?.setExternalLinkCallback(null);
    expect(calls).toEqual(['links']);
  });
});
