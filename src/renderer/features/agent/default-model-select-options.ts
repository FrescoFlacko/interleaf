import type { SelectOption } from '../../components/ui/select-model';
import { mergeDefaultModelOptions } from './model-options';

/**
 * The Settings "Default model" listbox. A stored default main no longer
 * offers stays listed and selected, marked as no longer offered, so reopening
 * Settings never silently swaps a saved choice for another model.
 */
export function defaultModelSelectOptions(availableModels: readonly string[], defaultModel: string | null): SelectOption[] {
  return [
    { value: '', label: 'Provider default' },
    ...mergeDefaultModelOptions(availableModels, defaultModel).map((model) => (
      availableModels.includes(model)
        ? { value: model, label: model }
        : { value: model, label: model, description: 'No longer offered by this CLI' }
    )),
  ];
}
