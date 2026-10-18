/**
 * Converts the raw captures from `tests/e2e/website-screenshots.spec.ts` into
 * the responsive WebP files the website ships.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON website.screens.ts --from /tmp/interleaf-site-captures
 *
 * Only the names in `SCREENS` are read, so a stray file in the capture
 * directory is never published. Encoding drops every metadata block. The
 * brand icon is derived from the application's own `resources/icon.png`.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ScreenSpec = {
  readonly name: string;
  /** Optional crop in source pixels, applied before resizing. */
  readonly crop?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
};

/** Every screenshot on the site; the capture spec writes `<name>.png`. */
export const SCREENS: readonly ScreenSpec[] = [
  // The grid ends well above the fold, so the empty lower half is cut.
  { name: 'library', crop: { left: 0, top: 0, width: 2880, height: 1000 } },
  { name: 'reader-annotations' },
  { name: 'reader-chat' },
  { name: 'reader-agent' },
  { name: 'reader-search' },
  { name: 'epub-sepia' },
  { name: 'epub-midnight' },
  { name: 'focus-mode' },
];

export const SCREEN_WIDTHS = [960, 1600, 2400] as const;

export function screenFileName(name: string, width: number): string {
  return `${name}-${String(width)}.webp`;
}

export async function optimiseScreens(fromDir: string, toDir: string): Promise<readonly string[]> {
  const { default: sharp } = await import('sharp');
  await mkdir(toDir, { recursive: true });
  const written: string[] = [];
  for (const screen of SCREENS) {
    const source = join(fromDir, `${screen.name}.png`);
    for (const width of SCREEN_WIDTHS) {
      let pipeline = sharp(source);
      if (screen.crop !== undefined) pipeline = pipeline.extract(screen.crop);
      const target = join(toDir, screenFileName(screen.name, width));
      await pipeline.resize({ width, withoutEnlargement: true }).webp({ quality: 78, effort: 6 }).toFile(target);
      written.push(target);
    }
  }
  return written;
}

/** Icon sizes: header mark, favicon and Apple touch icon. */
export const ICON_SIZES = [64, 180, 256] as const;

export async function optimiseBrand(projectRoot: string, toDir: string): Promise<readonly string[]> {
  const { default: sharp } = await import('sharp');
  await mkdir(toDir, { recursive: true });
  const written: string[] = [];
  for (const size of ICON_SIZES) {
    const target = join(toDir, `interleaf-icon-${String(size)}.png`);
    await sharp(join(projectRoot, 'resources', 'icon.png')).resize(size, size).png({ compressionLevel: 9 }).toFile(target);
    written.push(target);
  }
  return written;
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const flag = process.argv.indexOf('--from');
  const from = flag === -1 ? undefined : process.argv[flag + 1];
  if (from === undefined || from === '') throw new Error('Pass --from <directory of raw captures>.');
  const written = [
    ...(await optimiseScreens(resolve(from), join(projectRoot, 'website', 'assets', 'screens'))),
    ...(await optimiseBrand(projectRoot, join(projectRoot, 'website', 'assets', 'brand'))),
  ];
  process.stdout.write(`Interleaf website: ${String(written.length)} images written to website/assets\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
