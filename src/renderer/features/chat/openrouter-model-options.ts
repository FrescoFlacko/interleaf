import type { AIModelInfo, AIModelPrice, AIModelPricing } from '@shared/types/ai';

/** A catalog model plus whether it only survives because it is persisted. */
export type ModelOption = AIModelInfo & { readonly legacy: boolean };

const OPENROUTER_AUTO_MODEL: AIModelInfo = {
  id: 'openrouter/auto',
  name: 'OpenRouter Auto',
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  supportsStreaming: true,
  // Matches the live catalog: the dynamic Auto Router advertises -1/-1, an
  // undocumented sentinel — the price direction is conservatively unavailable.
  pricing: { input: { kind: 'unavailable' }, output: { kind: 'unavailable' } },
};

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(1)}M`;
  if (contextWindow >= 1_000) return `${String(Math.round(contextWindow / 1_000))}k`;
  return String(contextWindow);
}

/** Falls back to a shared "Not published" pair when a model carries no
 * pricing object at all (CLI providers, legacy persisted rows) instead of
 * letting JSX infer availability per call site. */
const PRICING_NOT_PUBLISHED: AIModelPricing = {
  input: { kind: 'not_published' },
  output: { kind: 'not_published' },
};

/** Formats a positive priced rate without ever rounding it into an
 * exact-looking "$0.0000/M" and without overflowing: ordinary magnitudes
 * keep two decimals, small magnitudes get enough fixed digits to stay
 * visibly non-zero, truly sub-precision rates fall back to scientific
 * notation, and rates so large that ×1,000,000 exceeds IEEE-754 range are
 * derived from the rate's own decimal exponent (exponent + 6) instead of
 * performing the overflowing multiplication — never Infinity/NaN. */
function formatPricedPerMillion(usdPerToken: number): string {
  const perMillion = usdPerToken * 1_000_000;
  if (Number.isFinite(perMillion)) {
    if (perMillion >= 0.01) return `$${perMillion.toFixed(2)}/M`;
    for (let precision = 4; precision <= 15; precision++) {
      const text = perMillion.toFixed(precision);
      if (Number(text) !== 0) return `$${text}/M`;
    }
    return `$${perMillion.toExponential(2)}/M`;
  }
  return `$${shiftScientificExponent(usdPerToken.toExponential(2), 6)}/M`;
}

/** Raises an "m.mme±x" scientific string's exponent by delta for the
 * per-token → per-million shift; renormalizes a mantissa that rounding
 * pushed to 10. Returns the input unchanged on unexpected shapes so a
 * malformed intermediate can never surface as Infinity/NaN text. */
function shiftScientificExponent(scientific: string, delta: number): string {
  const match = /^(\d(?:\.\d+)?)e([+-]\d+)$/.exec(scientific);
  if (!match) return scientific;
  let mantissa = Number(match[1]);
  let exponent = Number(match[2]) + delta;
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  return `${mantissa.toFixed(2)}e+${String(exponent)}`;
}

/** One direction's price, read after "input" or "output". */
function formatModelPrice(price: AIModelPrice): string {
  switch (price.kind) {
    case 'priced':
      return formatPricedPerMillion(price.usdPerToken);
    case 'free':
      return 'free';
    case 'unavailable':
      return 'unavailable';
    case 'not_published':
      return 'not published';
  }
}

/** Both directions alike and unpriced read as one phrase, not twice. */
const SHARED_PRICE_LABEL: Readonly<Record<Exclude<AIModelPrice['kind'], 'priced'>, string>> = {
  free: 'Free',
  unavailable: 'Pricing unavailable',
  not_published: 'Pricing not published',
};

function formatPricePair(pricing: AIModelPricing): string {
  const { input, output } = pricing;
  if (input.kind === output.kind && input.kind !== 'priced') return SHARED_PRICE_LABEL[input.kind];
  return `input ${formatModelPrice(input)} · output ${formatModelPrice(output)}`;
}

/** The concise name shown in the select itself (design 5a). */
export function modelSelectLabel(model: ModelOption): string {
  return model.legacy ? `Legacy/unavailable: ${model.name}` : model.name;
}

/** Identifier, context and pricing, rendered as a separate metadata line
 * beneath the select rather than crammed into every option. */
export function modelMetadataItems(model: ModelOption): readonly string[] {
  return [
    model.id,
    `${formatContextWindow(model.contextWindow)} context`,
    formatPricePair(model.pricing ?? PRICING_NOT_PUBLISHED),
  ];
}

/** Everything the picker may offer: Auto, the live catalog, and any persisted
 * or in-progress identifier the catalog no longer lists. */
export function buildModelOptions(input: {
  readonly catalogModels: readonly AIModelInfo[];
  readonly configuredModel: string;
  readonly draftModel: string;
}): readonly ModelOption[] {
  const map = new Map<string, ModelOption>();
  map.set('openrouter/auto', { ...OPENROUTER_AUTO_MODEL, legacy: false });
  for (const model of input.catalogModels) {
    map.set(model.id, { ...model, legacy: false });
  }
  for (const identifier of [input.configuredModel, input.draftModel]) {
    if (identifier && !map.has(identifier)) {
      map.set(identifier, {
        id: identifier,
        name: identifier,
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: false,
        legacy: true,
      });
    }
  }
  return [...map.values()];
}
