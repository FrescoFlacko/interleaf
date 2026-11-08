import { cancelPracticeNavigationOnInput } from './practice-navigation-cancellation';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { PracticeSource } from '@shared/schemas/practice';
import { useReaderStore, type ReaderSession } from '../../stores/use-reader-store';
import { navigateLearningSource } from '../reader/learning-source';

type NativeSource = Extract<PracticeSource, { kind: 'native' }>;
type Pending = { readonly source: NativeSource };
export const usePracticeNavigationStore = create<{ pending: Pending | null; setPending: (pending: Pending | null) => void }>((set) => ({
  pending: null, setPending: (pending) => { set({ pending }); },
}));

/** Resolve the quote only after the expected reader session has mounted. */
export function usePracticeNavigation(session: ReaderSession | null, pageCount: number): string {
  const pending = usePracticeNavigationStore((state) => state.pending);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pending || !session || pageCount <= 0) return;
    const current = () => useReaderStore.getState().session === session && usePracticeNavigationStore.getState().pending === pending;
    if (session.document.id !== pending.source.documentId || session.document.fileHash !== pending.source.documentHash) {
      usePracticeNavigationStore.getState().setPending(null);
      setError('The source document changed before it could be opened.');
      return;
    }
    const removeInputListeners = cancelPracticeNavigationOnInput(() => {
      if (current()) usePracticeNavigationStore.getState().setPending(null);
    });
    void navigateLearningSource(session.adapter, pending.source, current).then((found) => {
      if (!current()) return;
      usePracticeNavigationStore.getState().setPending(null);
      setError(found ? 'Source passage opened.' : 'The source passage could not be resolved in this document.');
    }).catch(() => {
      if (!current()) return;
      usePracticeNavigationStore.getState().setPending(null);
      setError('The source passage could not be resolved in this document.');
    });
    return removeInputListeners;
  }, [pending, session, pageCount]);
  return error;
}
