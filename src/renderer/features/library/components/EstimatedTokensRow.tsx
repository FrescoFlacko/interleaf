import { useEffect, useRef, useState } from 'react';
import type { DocumentIndexState } from '@shared/types/search';
import { bridge } from '../../../app/api-client';

/**
 * What Document details can truthfully say about the document's token size.
 * The number only ever comes from the main-owned index state; every other
 * outcome names the real reason instead of showing a plausible estimate.
 */
type EstimatedTokens =
  | { readonly kind: 'ready'; readonly tokens: number }
  | { readonly kind: 'loading' }
  | { readonly kind: 'indexing' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'not-indexed' }
  | { readonly kind: 'unavailable' };

const ESTIMATED_TOKENS_COPY: Record<Exclude<EstimatedTokens['kind'], 'ready'>, string> = {
  loading: 'Checking…',
  indexing: 'Indexing…',
  failed: 'Indexing failed',
  'not-indexed': 'Not indexed',
  unavailable: 'Unavailable',
};

function describeIndexState(state: DocumentIndexState | null, documentHash: string): EstimatedTokens {
  if (state === null || state.status === 'not_indexed') return { kind: 'not-indexed' };
  if (state.status === 'indexing') return { kind: 'indexing' };
  if (state.status === 'failed') return { kind: 'failed' };
  // A ready index for another revision, or one main could not vouch for, has no
  // estimate to show. A ready current index that extracted nothing reports the
  // exact `0` it measured.
  if (state.estimatedTokens === null || state.documentHash !== documentHash) {
    return { kind: 'unavailable' };
  }
  return { kind: 'ready', tokens: state.estimatedTokens };
}

/**
 * Reads the estimate for one document revision. Requests are sequenced so a
 * slow response for a previously inspected document can never populate the
 * details of the document the dialog shows now.
 */
function useEstimatedTokens(documentId: string, documentHash: string): EstimatedTokens {
  const [estimate, setEstimate] = useState<EstimatedTokens>({ kind: 'loading' });
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    setEstimate({ kind: 'loading' });
    void bridge.search.getIndexState(documentId).then(
      (state) => {
        if (sequence !== requestSequence.current) return;
        setEstimate(describeIndexState(state, documentHash));
      },
      () => {
        if (sequence !== requestSequence.current) return;
        setEstimate({ kind: 'unavailable' });
      }
    );
  }, [documentId, documentHash]);

  return estimate;
}

/** The rendered value plus whether it is a real number or a status word. */
function readout(estimate: EstimatedTokens): { readonly text: string; readonly isValue: boolean } {
  if (estimate.kind === 'ready') return { text: estimate.tokens.toLocaleString(), isValue: true };
  return { text: ESTIMATED_TOKENS_COPY[estimate.kind], isValue: false };
}

/**
 * Document details readout of the whole-document token estimate. It is a plain
 * row, never a focus stop, and it reports the indexing state in words while the
 * asynchronous lookup is still resolving.
 */
export function EstimatedTokensRow({
  documentId,
  documentHash,
}: {
  readonly documentId: string;
  readonly documentHash: string;
}) {
  const { text, isValue } = readout(useEstimatedTokens(documentId, documentHash));
  return (
    <div className="flex justify-between" data-testid="document-details-estimated-tokens">
      <span className="text-text-secondary">Estimated tokens</span>
      <span className={`font-medium ${isValue ? 'text-text-primary' : 'text-text-secondary'}`}>{text}</span>
    </div>
  );
}
