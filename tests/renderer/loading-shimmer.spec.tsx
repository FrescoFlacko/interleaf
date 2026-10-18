// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { LoadingShimmerText } from '../../src/renderer/components/LoadingShimmer';

const globalCss = readFileSync(resolve(__dirname, '../../src/renderer/styles/global.css'), 'utf8');

/** The block of `global.css` that governs the shimmer under reduced motion. */
function reducedMotionRules(): string {
  const blocks = globalCss.split('@media (prefers-reduced-motion: reduce)');
  return blocks.filter((block) => block.includes('ml-loading-shimmer')).join('\n');
}

describe('LoadingShimmerText', () => {
  afterEach(cleanup);

  it('keeps the loading text readable and announced', async () => {
    const { container } = render(
      <p role="status">
        <LoadingShimmerText>Loading documents...</LoadingShimmerText>
      </p>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading documents...');
    const shimmer = container.querySelector('[data-loading-shimmer="true"]');
    expect(shimmer?.textContent).toBe('Loading documents...');
    expect(shimmer?.getAttribute('aria-hidden')).toBeNull();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe('shimmer stylesheet', () => {
  it('is static at full opacity under prefers-reduced-motion: reduce', () => {
    const reduced = reducedMotionRules();
    expect(reduced).toContain('.ml-loading-shimmer');
    expect(reduced).toContain('animation: none');
    expect(reduced).toContain('opacity: 1');
    expect(reduced).toContain('color: var(--text-secondary)');
  });
});
