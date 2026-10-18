import type { SelectOption } from '../../../components/ui/select-model';

export const LINE_SPACING_OPTIONS: readonly SelectOption[] = [
  { value: '1.4', label: 'Tight lines' },
  { value: '1.65', label: 'Normal lines' },
  { value: '1.9', label: 'Relaxed lines' },
];

export const MARGIN_OPTIONS: readonly SelectOption[] = [
  { value: '1.25', label: 'Narrow margins' },
  { value: '2.5', label: 'Normal margins' },
  { value: '4', label: 'Wide margins' },
];

const ZOOM_PRESETS = ['fit-width', 'fit-page', '0.5', '0.75', '1.0', '1.25', '1.5', '2.0', '3.0'] as const;
const FIT_LABELS: Readonly<Record<string, string>> = { 'fit-width': 'Fit Width', 'fit-page': 'Fit Page' };

function percentLabel(scale: number): string {
  return `${String(Math.round(scale * 100))}%`;
}

function zoomPreset(zoom: number): string | undefined {
  return ZOOM_PRESETS.find((preset) => Number.parseFloat(preset) === zoom);
}

/** The value the zoom select shows: the fit mode, the matching preset, or the custom scale to two places. */
export function zoomSelectValue(zoomMode: string, zoom: number): string {
  if (zoomMode !== 'custom') return zoomMode;
  return zoomPreset(zoom) ?? zoom.toFixed(2);
}

/** Zoom presets, plus the current custom scale when it is not one of them. */
export function zoomOptions(zoomMode: string, zoom: number): SelectOption[] {
  const options = ZOOM_PRESETS.map((value) => ({ value, label: FIT_LABELS[value] ?? percentLabel(Number.parseFloat(value)) }));
  const custom = zoomMode === 'custom' && zoomPreset(zoom) === undefined;
  return custom ? [...options, { value: zoom.toFixed(2), label: percentLabel(zoom) }] : options;
}

/** A fit mode, a numeric scale, or `null` for a value that is neither. */
export function parseZoomChoice(value: string): 'fit-width' | 'fit-page' | number | null {
  if (value === 'fit-width' || value === 'fit-page') return value;
  const scale = Number.parseFloat(value);
  return Number.isNaN(scale) ? null : scale;
}
