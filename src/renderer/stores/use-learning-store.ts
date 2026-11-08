import { create } from 'zustand';
import type { LearningContent, LearningItem, LearningSource } from '@shared/schemas/learning';
import { bridge } from '../app/api-client';

type LearningState = {
  items: readonly LearningItem[];
  primary: LearningSource | null;
  secondary: LearningSource | null;
  error: string | null;
  pending: LearningSource | null;
  message: string;
  kind: LearningContent['kind'];
  title: string;
  body: string;
  setPending: (source: LearningSource | null) => void;
  setMessage: (message: string) => void;
  setKind: (kind: LearningContent['kind']) => void;
  setTitle: (title: string) => void;
  setBody: (body: string) => void;
  start: (source: LearningSource) => void;
  setSecondary: (source: LearningSource) => void;
  clearDraft: () => void;
  load: (documentId: string) => Promise<void>;
  create: (content: LearningContent) => Promise<boolean>;
  dismiss: (documentId: string, id: string) => Promise<void>;
  remove: (documentId: string, id: string) => Promise<void>;
};
let sequence = 0;
export const useLearningStore = create<LearningState>((set, get) => ({
  items: [], primary: null, secondary: null, error: null,
  pending: null, message: '', kind: 'question', title: '', body: '',
  setPending: (pending) => { set({ pending }); },
  setMessage: (message) => { set({ message }); },
  setKind: (kind) => { set({ kind }); },
  setTitle: (title) => { set({ title }); },
  setBody: (body) => { set({ body }); },
  start: (source) => { set({ primary: source, secondary: null, error: null, kind: 'question', title: '', body: '' }); },
  setSecondary: (source) => { set({ secondary: source }); },
  clearDraft: () => { set({ primary: null, secondary: null, title: '', body: '' }); },
  load: async (documentId) => {
    const request = ++sequence;
    set({ items: [] });
    try {
      const items = await bridge.learning.list(documentId);
      if (request === sequence) set({ items, error: null });
    } catch {
      if (request === sequence) set({ items: [], error: 'Could not load learning items.' });
    }
  },
  create: async (content) => {
    try {
      await bridge.learning.create(content);
      set({ primary: null, secondary: null, error: null });
      await get().load(content.primary.documentId);
      return true;
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : 'Could not save the learning item.' });
      return false;
    }
  },
  dismiss: async (documentId, id) => {
    try { await bridge.learning.dismiss(documentId, id); await get().load(documentId); }
    catch { set({ error: 'Could not dismiss the item.' }); }
  },
  remove: async (documentId, id) => {
    try { await bridge.learning.remove(documentId, id); await get().load(documentId); }
    catch { set({ error: 'Could not remove the item.' }); }
  },
}));
