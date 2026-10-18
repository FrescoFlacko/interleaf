import type { HighlightColor } from '../types/annotation';

export type HighlightColorConfig = {
  readonly id: HighlightColor;
  readonly label: string;
  readonly shortKey: string;
  readonly cssRgba: string;
  readonly buttonClass: string;
  readonly hexValue: string;
};

export const HIGHLIGHT_COLOR_CONFIGS: Readonly<Record<HighlightColor, HighlightColorConfig>> = Object.freeze({
  yellow: Object.freeze({
    id: 'yellow',
    label: 'Yellow',
    shortKey: 'Y',
    cssRgba: 'rgba(250, 204, 21, 0.42)',
    buttonClass: 'bg-yellow-300 text-yellow-950',
    hexValue: '#facc15',
  }),
  blue: Object.freeze({
    id: 'blue',
    label: 'Blue',
    shortKey: 'B',
    cssRgba: 'rgba(96, 165, 250, 0.38)',
    buttonClass: 'bg-blue-300 text-blue-950',
    hexValue: '#60a5fa',
  }),
  green: Object.freeze({
    id: 'green',
    label: 'Green',
    shortKey: 'G',
    cssRgba: 'rgba(74, 222, 128, 0.38)',
    buttonClass: 'bg-green-300 text-green-950',
    hexValue: '#4ade80',
  }),
  pink: Object.freeze({
    id: 'pink',
    label: 'Pink',
    shortKey: 'P',
    cssRgba: 'rgba(244, 114, 182, 0.38)',
    buttonClass: 'bg-pink-300 text-pink-950',
    hexValue: '#f472b6',
  }),
  purple: Object.freeze({
    id: 'purple',
    label: 'Purple',
    shortKey: 'V',
    cssRgba: 'rgba(192, 132, 252, 0.38)',
    buttonClass: 'bg-purple-300 text-purple-950',
    hexValue: '#c084fc',
  }),
});

export const HIGHLIGHT_COLOR_OPTIONS: readonly HighlightColorConfig[] = Object.freeze([
  HIGHLIGHT_COLOR_CONFIGS.yellow,
  HIGHLIGHT_COLOR_CONFIGS.blue,
  HIGHLIGHT_COLOR_CONFIGS.green,
  HIGHLIGHT_COLOR_CONFIGS.pink,
  HIGHLIGHT_COLOR_CONFIGS.purple,
]);

export const DEFAULT_HIGHLIGHT_RGBA = HIGHLIGHT_COLOR_CONFIGS.yellow.cssRgba;

export const HIGHLIGHT_API_NAMES = Object.freeze([
  'interleaf-yellow',
  'interleaf-blue',
  'interleaf-green',
  'interleaf-pink',
  'interleaf-purple',
  'interleaf-note',
] as const);
