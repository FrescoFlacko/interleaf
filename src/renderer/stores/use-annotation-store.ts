import { create } from 'zustand';
import type {
  Annotation,
  AnnotationAnchorScope,
  AnnotationFilter,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from '@shared/types/annotation';
import type { InterleafAPI } from '@shared/types/api';
import type {
  AnnotationAnchorResolution,
  ReaderSelection,
  SelectionIssue,
} from '../features/reader/types';
import { bridge } from '../app/api-client';

let loadSequence = 0;
const repairsInFlight = new Set<string>();
const MAX_RENDERED_ANNOTATIONS = 2_000;

/**
 * A one-shot request to bring a just-created annotation into view in the
 * Annotations panel.
 *
 * Only an explicit creation that also opens the panel raises one, so an
 * ordinary reload, edit, delete, filter change, or background refresh never
 * moves the reader's scroll position. `nonce` makes two consecutive requests
 * for the same annotation distinguishable, and the panel clears the request by
 * nonce once it has revealed it, so the reveal happens exactly once.
 *
 * The document is part of the request because the panel is shared: a reader
 * who leaves for another book before the row arrives must not have that book's
 * list scrolled on behalf of an annotation that is not in it.
 */
type AnnotationRevealRequest = {
  readonly documentId: string;
  readonly annotationId: string;
  readonly nonce: number;
};

let revealSequence = 0;

/**
 * The document revision and mounted region whose annotations the store holds.
 * A load names all three at once, and every reload repeats them together.
 */
export type LoadedAnnotationDocument = {
  readonly documentId: string;
  readonly documentHash: string;
  readonly scope: AnnotationAnchorScope;
};

export type AnnotationState = {
  /** What the last load asked for; `null` until a document's annotations are requested. */
  loaded: LoadedAnnotationDocument | null;
  annotations: readonly Annotation[];
  mutationRevision: number;
  selection: ReaderSelection | null;
  /** Why the last selection could not be captured; `null` once a selection succeeds or is cleared. */
  selectionIssue: SelectionIssue | null;
  isLoading: boolean;
  error: string | null;
  /** Pending one-shot reveal for the annotations panel; null when none. */
  revealRequest: AnnotationRevealRequest | null;
  requestReveal: (documentId: string, annotationId: string) => void;
  /** Clears the pending reveal, ignoring a request raised after `nonce`. */
  clearReveal: (nonce: number) => void;
  load: (documentId: string, scope: AnnotationAnchorScope, documentHash: string) => Promise<void>;
  create: (input: CreateAnnotationInput) => Promise<Annotation | null>;
  update: (input: UpdateAnnotationInput) => Promise<Annotation | null>;
  remove: (documentId: string, id: string) => Promise<boolean>;
  repairResolution: (documentHash: string, resolution: AnnotationAnchorResolution) => Promise<void>;
  setSelection: (selection: ReaderSelection | null, selectionIssue: SelectionIssue | null) => void;
  clearSelectionError: () => void;
  reset: () => void;
};

function errorMessage(cause: Error | null): string {
  return cause instanceof Error ? cause.message : 'The annotation request failed.';
}

/** One page of annotations at a time is all this store ever asks for. */
type AnnotationPager = Pick<InterleafAPI['annotations'], 'page'>;

type AnnotationPage = { readonly items: readonly Annotation[]; readonly total: number };

const EMPTY_PAGE: AnnotationPage = { items: [], total: 0 };

/**
 * Every annotation matching one filter, paged up to the paint limit.
 *
 * Paging yields to the event loop between requests so a large document does not
 * block the reader, and a load that a newer one has overtaken stops with an
 * empty page rather than painting a stale document's annotations.
 */
async function collectAnnotations(
  api: AnnotationPager,
  documentId: string,
  extraFilter: Pick<AnnotationFilter, 'scope' | 'documentHashNot'>,
  isCurrent: () => boolean,
): Promise<AnnotationPage> {
  const items: Annotation[] = [];
  let total = 0;
  for (let offset = 0; offset < MAX_RENDERED_ANNOTATIONS; offset += 100) {
    const page = await api.page(documentId, { offset, limit: 100, sort: 'updated_desc', ...extraFilter });
    total = page.total;
    items.push(...page.items);
    if (items.length >= total || page.items.length < page.limit) break;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    if (!isCurrent()) return EMPTY_PAGE;
  }
  return { items, total };
}

/** Tells the reader when more annotations exist than the page paints. */
function paintLimitNotice(scoped: AnnotationPage, stale: AnnotationPage): string | null {
  if (scoped.total <= MAX_RENDERED_ANNOTATIONS && stale.total <= MAX_RENDERED_ANNOTATIONS) return null;
  return `Only the newest ${String(MAX_RENDERED_ANNOTATIONS)} annotations in the active scope are painted; every annotation remains available in the paged browser.`;
}

function isLoadedDocument(state: Pick<AnnotationState, 'loaded'>, documentId: string): boolean {
  return state.loaded?.documentId === documentId;
}

/** Reloads the loaded document's annotations after a mutation that touched it. */
function reloadIfLoaded(get: () => AnnotationState, documentId: string): void {
  const { loaded } = get();
  if (loaded?.documentId !== documentId) return;
  void get().load(loaded.documentId, loaded.scope, loaded.documentHash);
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  loaded: null,
  annotations: [],
  mutationRevision: 0,
  selection: null,
  selectionIssue: null,
  isLoading: false,
  error: null,
  revealRequest: null,

  requestReveal: (documentId, annotationId) => {
    revealSequence += 1;
    set({ revealRequest: { documentId, annotationId, nonce: revealSequence } });
  },

  clearReveal: (nonce) => {
    set((state) => state.revealRequest?.nonce === nonce ? { revealRequest: null } : state);
  },

  load: async (documentId, scope, documentHash) => {
    const sequence = ++loadSequence;
    const api = bridge.annotations;
    set({
      loaded: { documentId, documentHash, scope },
      isLoading: true,
      error: null,
    });
    const isCurrent = (): boolean => sequence === loadSequence;
    try {
      const scoped = await collectAnnotations(api, documentId, { scope }, isCurrent);
      if (!isCurrent()) return;
      const stale = await collectAnnotations(api, documentId, { documentHashNot: documentHash }, isCurrent);
      if (!isCurrent()) return;
      const annotations = [...new Map(
        [...scoped.items, ...stale.items].map((annotation) => [annotation.id, annotation])
      ).values()];
      if (sequence === loadSequence && isLoadedDocument(get(), documentId)) {
        set({ annotations, isLoading: false, error: paintLimitNotice(scoped, stale) });
      }
    } catch (error) {
      const caught = error instanceof Error ? error : null;
      if (isCurrent() && isLoadedDocument(get(), documentId)) {
        set({ isLoading: false, error: errorMessage(caught) });
      }
    }
  },

  create: async (input) => {
    try {
      const annotation = await bridge.annotations.create(input);
      set((state) => isLoadedDocument(state, input.documentId)
        ? {
            annotations: [annotation, ...state.annotations],
            selection: null,
            error: null,
            mutationRevision: state.mutationRevision + 1,
          }
        : state);
      reloadIfLoaded(get, input.documentId);
      return annotation;
    } catch (error) {
      set({ error: errorMessage(error instanceof Error ? error : null) });
      return null;
    }
  },

  update: async (input) => {
    try {
      const annotation = await bridge.annotations.update(input);
      if (annotation) {
        set((state) => isLoadedDocument(state, input.documentId)
          ? {
              annotations: state.annotations.map((item) => item.id === annotation.id ? annotation : item),
              error: null,
              mutationRevision: state.mutationRevision + 1,
            }
          : state);
        reloadIfLoaded(get, input.documentId);
      }
      return annotation;
    } catch (error) {
      set({ error: errorMessage(error instanceof Error ? error : null) });
      return null;
    }
  },

  remove: async (documentId, id) => {
    try {
      const deleted = await bridge.annotations.delete(documentId, id);
      if (!deleted) return false;
      set((state) => isLoadedDocument(state, documentId)
        ? {
            annotations: state.annotations.filter((item) => item.id !== id),
            error: null,
            mutationRevision: state.mutationRevision + 1,
          }
        : state);
      reloadIfLoaded(get, documentId);
      return true;
    } catch (error) {
      set({ error: errorMessage(error instanceof Error ? error : null) });
      return false;
    }
  },

  repairResolution: async (documentHash, resolution) => {
    const annotation = get().annotations.find((item) => item.id === resolution.annotationId);
    if (!annotation || repairsInFlight.has(annotation.id)) return;
    const unchanged =
      annotation.status === resolution.status &&
      annotation.documentHash === documentHash &&
      JSON.stringify(annotation.anchor) === JSON.stringify(resolution.anchor);
    if (unchanged) return;
    repairsInFlight.add(annotation.id);
    try {
      const repaired = await bridge.annotations.repairAnchor({
        documentId: annotation.documentId,
        id: annotation.id,
        documentHash,
        anchor: resolution.anchor,
        status: resolution.status,
      });
      if (repaired) {
        set((state) => isLoadedDocument(state, repaired.documentId)
          ? {
              annotations: state.annotations.map((item) => item.id === repaired.id ? repaired : item),
              mutationRevision: state.mutationRevision + 1,
            }
          : state);
      }
    } catch (error) {
      set({ error: errorMessage(error instanceof Error ? error : null) });
    } finally {
      repairsInFlight.delete(annotation.id);
    }
  },

  setSelection: (selection, selectionIssue) => {
    set({
      selection,
      selectionIssue: selection ? null : selectionIssue,
    });
  },

  clearSelectionError: () => {
    set({ selectionIssue: null });
  },

  reset: () => {
    loadSequence += 1;
    repairsInFlight.clear();
    set({
      loaded: null,
      annotations: [],
      mutationRevision: 0,
      selection: null,
      selectionIssue: null,
      error: null,
      revealRequest: null,
    });
  },
}));
