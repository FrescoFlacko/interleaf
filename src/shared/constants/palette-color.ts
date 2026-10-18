/**
 * Small colour helpers for palette tokens: parsing the `#rrggbb` / `rgb()` /
 * `rgba()` forms the palettes and computed styles use, WCAG relative
 * luminance, and contrast ratio. Pure and portable so the renderer, the reader
 * adapters and the contrast tests share one definition.
 */
export type Rgb = readonly [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FUNCTION = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

export function parseCssColor(value: string): Rgb | null {
  const trimmed = value.trim();
  const hex = HEX.exec(trimmed)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? hex.replace(/./g, (digit) => digit + digit) : hex;
    const channel = (start: number): number => Number.parseInt(full.slice(start, start + 2), 16);
    return [channel(0), channel(2), channel(4)];
  }
  const rgb = RGB_FUNCTION.exec(trimmed);
  if (rgb === null) return null;
  const channel = (raw: string | undefined): number => Math.min(255, Number(raw));
  return [channel(rgb[1]), channel(rgb[2]), channel(rgb[3])];
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]: Rgb): number {
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Paints `foreground` at `alpha` over an opaque `background`. */
export function compositeOver(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  const mix = (index: 0 | 1 | 2): number => foreground[index] * alpha + background[index] * (1 - alpha);
  return [mix(0), mix(1), mix(2)];
}

/**
 * Whether a background reads as dark. Uses luminance rather than the spelling
 * of the value, so any dark colour (including `#3x` hex and `rgb()` forms)
 * is classified correctly. Unparseable input is treated as light, matching
 * the page default.
 */
export function isDarkColor(value: string): boolean {
  const rgb = parseCssColor(value);
  return rgb !== null && relativeLuminance(rgb) < 0.18;
}

export function toRgba([red, green, blue]: Rgb, alpha: number): string {
  return `rgba(${String(Math.round(red))}, ${String(Math.round(green))}, ${String(Math.round(blue))}, ${String(alpha)})`;
}
