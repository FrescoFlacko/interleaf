export const PALETTE_IDS = [
  'paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight',
  'porcelain', 'birch', 'celadon', 'fjord', 'heather', 'marigold', 'rosewater', 'chalk', 'contrast-light',
  'ink', 'nocturne', 'evergreen', 'abyss', 'carbon', 'oxblood', 'dusk', 'umber', 'contrast-dark',
] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];

export type PaletteAppearance = 'light' | 'dark';

export type PaletteInfo = { readonly id: PaletteId;
readonly label: string;
readonly mood: string;
readonly appearance: PaletteAppearance; }

/**
 * Application and reading palettes (docs/UX_SPEC.md §2). The first six ids are
 * the original palettes and stay valid for stored settings. Token values live
 * in `palette-tokens-light.ts` / `palette-tokens-dark.ts`; the renderer applies
 * them at runtime through `src/renderer/styles/apply-palette.ts`.
 */
export const PALETTES: readonly PaletteInfo[] = [
  { id: 'paper', label: 'Paper', mood: 'Neutral daylight page, sky-ink links', appearance: 'light' },
  { id: 'sepia', label: 'Sepia', mood: 'Traditional low-glare ebook page', appearance: 'light' },
  { id: 'moss', label: 'Moss', mood: 'Muted lichen green, quiet focus', appearance: 'light' },
  { id: 'ocean', label: 'Ocean', mood: 'Crisp blue-grey coast light', appearance: 'light' },
  { id: 'porcelain', label: 'Porcelain', mood: 'Cool white with cobalt glaze', appearance: 'light' },
  { id: 'birch', label: 'Birch', mood: 'Pale bark grey, charcoal ink', appearance: 'light' },
  { id: 'celadon', label: 'Celadon', mood: 'Glazed jade with deep teal', appearance: 'light' },
  { id: 'fjord', label: 'Fjord', mood: 'Glacial grey-blue, slate water', appearance: 'light' },
  { id: 'heather', label: 'Heather', mood: 'Lavender moor, aubergine ink', appearance: 'light' },
  { id: 'marigold', label: 'Marigold', mood: 'Butter-yellow page, indigo ink', appearance: 'light' },
  { id: 'rosewater', label: 'Rosewater', mood: 'Blush page, oxblood ink', appearance: 'light' },
  { id: 'chalk', label: 'Chalk', mood: 'Editor’s white with red-pencil marks', appearance: 'light' },
  { id: 'contrast-light', label: 'High Contrast Light', mood: 'Maximum legibility, black on white', appearance: 'light' },
  { id: 'graphite', label: 'Graphite', mood: 'Medium slate for long evenings', appearance: 'dark' },
  { id: 'midnight', label: 'Midnight', mood: 'True-black OLED reading', appearance: 'dark' },
  { id: 'ink', label: 'Ink', mood: 'Blue-black ink, lamplight amber', appearance: 'dark' },
  { id: 'nocturne', label: 'Nocturne', mood: 'Deep violet night, mint highlights', appearance: 'dark' },
  { id: 'evergreen', label: 'Evergreen', mood: 'Pine forest at dusk, brass accents', appearance: 'dark' },
  { id: 'abyss', label: 'Abyss', mood: 'Deep-sea teal, soft cyan', appearance: 'dark' },
  { id: 'carbon', label: 'Carbon', mood: 'Neutral graphite fibre, signal blue', appearance: 'dark' },
  { id: 'oxblood', label: 'Oxblood', mood: 'Leather-bound library, rose-gold', appearance: 'dark' },
  { id: 'dusk', label: 'Dusk', mood: 'Indigo twilight, apricot glow', appearance: 'dark' },
  { id: 'umber', label: 'Umber', mood: 'Roasted earth, parchment text', appearance: 'dark' },
  { id: 'contrast-dark', label: 'High Contrast Dark', mood: 'Maximum legibility, white on black', appearance: 'dark' },
];

export const DEFAULT_PALETTE: PaletteId = 'paper';
