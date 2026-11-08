// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LearningSource } from '@shared/schemas/learning';
import { LearningSourceReference } from '../../src/renderer/features/reader/components/LearningSourceReference';
import { stubBridge } from '../helpers/interleaf-api';

const source: LearningSource = { documentId: 'missing-doc', documentHash: 'hash', anchor: {
  format: 'markdown', blockIndex: 1, quote: { exact: '<img src=x>', prefix: '', suffix: '' },
} };
afterEach(cleanup);

describe('learning source reference', () => {
  it('shows the missing identity and literal quote without offering navigation', async () => {
    stubBridge({ learning: { sourceStatus: () => Promise.resolve({ status: 'missing', title: null }) } });
    const follow = vi.fn();
    const { container } = render(<LearningSourceReference ownerId="owner" source={source} label="Open source" onFollow={follow} />);
    expect(await screen.findByText(/document ID: missing-doc/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeDisabled();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x>');
    expect(follow).not.toHaveBeenCalled();
  });
  it('marks changed sources and disables their navigation', async () => {
    stubBridge({ learning: { sourceStatus: () => Promise.resolve({ status: 'stale', title: 'Changed book' }) } });
    render(<LearningSourceReference ownerId="owner" source={source} label="Open source" onFollow={vi.fn()} />);
    expect(await screen.findByText('Changed book')).toBeInTheDocument();
    expect(screen.getByText('Source has changed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeDisabled();
  });
});
