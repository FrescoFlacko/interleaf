import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { BRAND_ICON_FILE_NAME, brandIconCandidatePaths } from '@main/app/brand-icon';
import { APP_NAME } from '@shared/constants/brand';
import { BRAND_ICNS_SOURCE, devBundleIdentity } from '../../electron.dev-bundle';

/**
 * The shipping application icon is a macOS-style *squircle*, not the square
 * brand master, not a circle, and not a plain rounded rectangle.
 *
 * `resources/brand/interleaf-logo.png` stays the archival master: an opaque
 * 1254x1254 raster with a full white square canvas. `resources/icon.png` is
 * derived from it on Apple's icon grid:
 *
 *   canvas   1024x1024 RGBA, fully transparent
 *   shape    824x824 visible boundary at x,y = 100..923 (100px gutter)
 *   corners  continuous-corner squircle, nominal radius 185.4px (22.5% of
 *            824) with corner smoothing 0.6. Each 90 degree corner is a
 *            circular arc section of 81.02px flanked by two cubic Beziers
 *            (a=103.83, b=51.92, c=39.66, d=20.21; the curve leaves the
 *            straight edge p=296.64px from the corner), i.e. the
 *            figma-squircle construction, not a bare quarter circle.
 *   shadow   black at 50% opacity, y offset +12px, 28px blur (Gaussian
 *            sigma 14), no spread, drawn inside the same 1024 canvas
 *   mark     the master trimmed of its white field, fit into a 560px box
 *            (68% of the boundary) at left 232 / top 268 - centred, then
 *            raised 8px because the mark tapers to a point
 *   iconset  the same master resampled (lanczos3) to the ten Apple sizes,
 *            then `iconutil -c icns` into resources/icon.icns
 *
 * The assertions below pin that geometry: outer transparency, the exact
 * boundary box, and a footprint that no circle, square, or quarter-circle
 * rounded rectangle of the same radius can satisfy.
 */

const ROOT = process.cwd();
const ICON_PNG = join(ROOT, 'resources', BRAND_ICON_FILE_NAME);
const ICONSET = join(ROOT, 'resources', 'Interleaf.iconset');

const SIZE = 1024;
const BOX = 824;
const GUTTER = 100;
const BOUNDARY_END = GUTTER + BOX - 1;
const RADIUS = 185.4;
const CENTRE = SIZE / 2;
/** Alpha at or above this is the shape itself; the shadow never reaches it. */
const OPAQUE = 250;

type Pixels = {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
};

async function readPixels(path: string): Promise<Pixels> {
  const { data, info } = await sharp(readFileSync(path))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** RGBA at a pixel; the raw buffer is tightly packed at 4 channels. */
function pixelAt(pixels: Pixels, x: number, y: number): readonly [number, number, number, number] {
  const offset = (y * pixels.width + x) * 4;
  return [
    pixels.data[offset] ?? 0,
    pixels.data[offset + 1] ?? 0,
    pixels.data[offset + 2] ?? 0,
    pixels.data[offset + 3] ?? 0,
  ];
}

function alphaAt(pixels: Pixels, x: number, y: number): number {
  return pixelAt(pixels, x, y)[3];
}

/** Bounding box and area of the fully opaque shape, ignoring the shadow. */
function opaqueFootprint(pixels: Pixels) {
  let minX = pixels.width;
  let minY = pixels.height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (alphaAt(pixels, x, y) < OPAQUE) continue;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, area };
}

/** Number of fully opaque pixels in one column of the raster. */
function opaqueColumnRun(pixels: Pixels, x: number): number {
  let run = 0;
  for (let y = 0; y < pixels.height; y += 1) {
    if (alphaAt(pixels, x, y) >= OPAQUE) run += 1;
  }
  return run;
}

const icon = await readPixels(ICON_PNG);

describe('the derived squircle application icon', () => {
  it('is a 1024x1024 RGBA raster', async () => {
    const metadata = await sharp(readFileSync(ICON_PNG)).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(SIZE);
    expect(metadata.height).toBe(SIZE);
    expect(metadata.channels).toBe(4);
    expect(metadata.hasAlpha).toBe(true);
  });

  it('leaves every canvas corner fully transparent', () => {
    const last = SIZE - 1;

    for (const [x, y] of [
      [0, 0],
      [last, 0],
      [0, last],
      [last, last],
    ] as const) {
      expect(alphaAt(icon, x, y)).toBe(0);
    }
  });

  it('places the visible boundary at 824x824 inside a 100px gutter', () => {
    const footprint = opaqueFootprint(icon);

    // Antialiasing can shave the outermost row/column, so allow one pixel.
    expect(footprint.minX).toBeGreaterThanOrEqual(GUTTER - 1);
    expect(footprint.minX).toBeLessThanOrEqual(GUTTER + 1);
    expect(footprint.minY).toBeGreaterThanOrEqual(GUTTER - 1);
    expect(footprint.minY).toBeLessThanOrEqual(GUTTER + 1);
    expect(footprint.maxX).toBeGreaterThanOrEqual(BOUNDARY_END - 1);
    expect(footprint.maxX).toBeLessThanOrEqual(BOUNDARY_END + 1);
    expect(footprint.maxY).toBeGreaterThanOrEqual(BOUNDARY_END - 1);
    expect(footprint.maxY).toBeLessThanOrEqual(BOUNDARY_END + 1);

    // Left and right gutters are clear of the shape and of the shadow, which
    // only spreads 14px of sigma from a boundary 100px inside the canvas.
    expect(alphaAt(icon, GUTTER - 60, CENTRE)).toBe(0);
    expect(alphaAt(icon, BOUNDARY_END + 60, CENTRE)).toBe(0);
  });

  it('has a squircle footprint: neither a circle, a square, nor a rounded rectangle', () => {
    const footprint = opaqueFootprint(icon);

    // Area share of the 824 box. A square fills 1.0 and the inscribed circle
    // 0.785; the continuous corners cut a little under 5%.
    const coverage = footprint.area / (BOX * BOX);
    expect(coverage).toBeGreaterThan(0.93);
    expect(coverage).toBeLessThan(0.98);

    // Sharp corners are cut away: 10px in from the corner of the boundary box
    // is outside the shape, so a full square fails here.
    expect(alphaAt(icon, GUTTER + 10, GUTTER + 10)).toBe(0);
    expect(alphaAt(icon, BOUNDARY_END - 10, BOUNDARY_END - 10)).toBe(0);

    // ...but the flanks are flat, well outside the inscribed circle: this
    // point is 431px from the centre, past the 412px circle radius.
    expect(alphaAt(icon, 900, 700)).toBe(255);
    expect(alphaAt(icon, 124, 324)).toBe(255);

    // The straight run of the boundary column is the sharpest discriminator.
    // Square: 824. Quarter-circle rounded rect of radius 185.4: 824 - 2*185.4
    // = 453. Circle: a tangent point, ~0. The continuous corner leaves the
    // edge p=296.6px from each end, so ~230-330 pixels stay flush.
    const run = opaqueColumnRun(icon, GUTTER);
    expect(run).toBeGreaterThan(220);
    expect(run).toBeLessThan(340);
    // Same shape rotated: the top boundary row behaves identically.
    let topRun = 0;
    for (let x = 0; x < SIZE; x += 1) {
      if (alphaAt(icon, x, GUTTER) >= OPAQUE) topRun += 1;
    }
    expect(Math.abs(topRun - run)).toBeLessThan(60);
    // A quarter-circle corner would already be flush against the edge 185.4px
    // down from the corner; the continuous corner is still easing in here, so
    // the boundary column is not yet fully covered.
    expect(alphaAt(icon, GUTTER, GUTTER + Math.round(RADIUS) + 40)).toBeLessThan(OPAQUE);
  });

  it('drops a soft 50% black shadow downwards', () => {
    // Below the shape: a semi-transparent band that never exceeds 50% black.
    let maxBelow = 0;
    for (let y = BOUNDARY_END + 1; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        maxBelow = Math.max(maxBelow, alphaAt(icon, x, y));
      }
    }
    expect(maxBelow).toBeGreaterThan(40);
    expect(maxBelow).toBeLessThanOrEqual(128);

    // Above the shape: far less, because the shadow is offset down by 12px.
    let maxAbove = 0;
    for (let y = 0; y < GUTTER; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        maxAbove = Math.max(maxAbove, alphaAt(icon, x, y));
      }
    }
    expect(maxAbove).toBeLessThan(maxBelow);

    // The shadow is black, not a coloured halo.
    const [red, green, blue, alpha] = pixelAt(icon, CENTRE, BOUNDARY_END + 15);
    expect(alpha).toBeGreaterThan(0);
    expect(Math.max(red, green, blue)).toBeLessThan(24);
  });

  it('carries the mark, legibly scaled and centred, over an off-white face', () => {
    // Ink: pixels where the green channel clearly leads. Its box must fill a
    // useful share of the shape - neither a lost speck nor edge to edge.
    let minX = SIZE;
    let minY = SIZE;
    let maxX = -1;
    let maxY = -1;
    for (let y = GUTTER; y <= BOUNDARY_END; y += 1) {
      for (let x = GUTTER; x <= BOUNDARY_END; x += 1) {
        const [red, green, blue] = pixelAt(icon, x, y);
        if (green <= red + 18 || green <= blue + 18) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const width = maxX - minX;
    const height = maxY - minY;
    expect(width / BOX).toBeGreaterThan(0.55);
    expect(width / BOX).toBeLessThan(0.8);
    expect(height / BOX).toBeGreaterThan(0.45);
    // Horizontally centred within a few pixels.
    expect(Math.abs((minX + maxX) / 2 - CENTRE)).toBeLessThan(8);
    // Vertically centred, with the small upward optical nudge.
    expect(CENTRE - (minY + maxY) / 2).toBeGreaterThan(0);
    expect(CENTRE - (minY + maxY) / 2).toBeLessThan(24);

    // The face around the mark is the opaque off-white fill, not a bright
    // rectangle bleeding to the canvas edge.
    const face = pixelAt(icon, CENTRE, GUTTER + 20);
    expect(face[3]).toBe(255);
    expect(Math.min(face[0], face[1], face[2])).toBeGreaterThan(240);
  });
});

describe('the macOS iconset derived from it', () => {
  // The smallest and largest members; the icns round-trip below covers the set.
  const SIZES = [
    ['icon_16x16.png', 16],
    ['icon_512x512@2x.png', 1024],
  ] as const;

  it.each(SIZES)('%s is a square RGBA raster with transparent corners', async (name, size) => {
    const path = join(ICONSET, name);
    const metadata = await sharp(readFileSync(path)).metadata();
    expect(metadata.width).toBe(size);
    expect(metadata.height).toBe(size);
    expect(metadata.hasAlpha).toBe(true);

    const pixels = await readPixels(path);
    const last = size - 1;
    expect(alphaAt(pixels, 0, 0)).toBe(0);
    expect(alphaAt(pixels, last, last)).toBe(0);
    // Still legible at 16px: the centre carries the mark, fully opaque.
    expect(alphaAt(pixels, size >> 1, size >> 1)).toBe(255);
  });

  it('has been compiled into resources/icon.icns', () => {
    const icns = join(ROOT, 'resources', 'icon.icns');
    expect(existsSync(icns)).toBe(true);
    const bytes = readFileSync(icns);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('icns');
    // The declared length is the real file length: a truncated or stale icns
    // would not round-trip here.
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  });
});

describe('the icon is wired into every surface that shows it', () => {
  const builder = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');

  it('names the derived rasters in the packaging configuration', () => {
    expect(builder).toContain('icon: resources/icon.icns');
    expect(builder).toContain('icon: resources/icon.png');
    // Shipped outside the asar so main can hand BrowserWindow a real path.
    expect(builder).toContain('from: resources/icon.png');
    expect(builder).toContain('to: icon.png');
  });

  it('keeps the packaged macOS bundle on the Interleaf name and icns', () => {
    expect(builder).toContain('productName: Interleaf');
    expect(builder).toContain('appId: com.interleaf.app');
    expect(builder).toMatch(/mac:\n\s+icon: resources\/icon\.icns/);
    // The generated development clone must never be nested inside a package.
    expect(builder).toContain("'!out/dev-app'");
  });

  it('gives the unpackaged macOS clone the same app-owned icns under its own name', () => {
    // The clone inherits `electron.icns` from the copied bundle, so its plist
    // has to name an Interleaf-owned file taken from this same resource.
    expect(BRAND_ICNS_SOURCE).toBe(join('resources', 'icon.icns'));
    expect(existsSync(join(ROOT, BRAND_ICNS_SOURCE))).toBe(true);
    expect(devBundleIdentity(APP_NAME).CFBundleIconFile).toBe(`${APP_NAME}.icns`);
    expect(devBundleIdentity(APP_NAME).CFBundleIconFile).not.toBe('electron.icns');
  });

  it('resolves the same file name at runtime', () => {
    expect(BRAND_ICON_FILE_NAME).toBe('icon.png');
    expect(brandIconCandidatePaths({ mainDirectory: '/repo/out/main' })).toEqual([
      '/repo/resources/icon.png',
    ]);
  });
});
