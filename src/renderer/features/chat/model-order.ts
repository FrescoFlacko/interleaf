import type { AIModelInfo } from '@shared/types/ai';
import { isProviderDefaultModel } from './chat-labels';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * A provider's catalog in the order the model menu lists it: the provider's own
 * default first, then every other model alphabetically by the name shown.
 *
 * Catalogs arrive in whatever order the provider reports them — Omp interleaves
 * models from every upstream provider it knows — which leaves a long list with
 * no order a reader can scan. Only display order changes; ids and the binding
 * are untouched.
 */
export function modelsInDisplayOrder(models: readonly AIModelInfo[]): readonly AIModelInfo[] {
  return [...models].sort((left, right) => {
    const leftDefault = isProviderDefaultModel(left.id);
    if (leftDefault !== isProviderDefaultModel(right.id)) return leftDefault ? -1 : 1;
    return collator.compare(left.name, right.name) || collator.compare(left.id, right.id);
  });
}
