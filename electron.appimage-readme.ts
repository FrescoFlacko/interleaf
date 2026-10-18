import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plain-text install instructions shipped beside every built AppImage, so a
 * user can read them without launching the app. One template
 * (resources/linux/README-AppImage.txt) is rendered with the AppImage's file
 * name; electron.update-release.ts stages the same rendering as a release
 * asset covered by the signed SHA256SUMS.
 *
 * electron-builder.yml runs `afterAllArtifactBuild` after every build. It only
 * writes into directories that hold a freshly built AppImage, so macOS,
 * Windows, deb/pacman-only and `--dir` builds are left untouched.
 */

export const APPIMAGE_README_NAME = 'README-AppImage.txt';
const TEMPLATE_PATH = fileURLToPath(new URL('./resources/linux/README-AppImage.txt', import.meta.url));
const PLACEHOLDER = '{{APPIMAGE}}';
/** Used when one output directory holds several AppImages (more than one arch). */
const ANY_APPIMAGE = 'Interleaf-*.AppImage';

/** The README text for the AppImage with this file name. */
export function appImageReadme(appImageName: string): string {
  return readFileSync(TEMPLATE_PATH, 'utf8').replaceAll(PLACEHOLDER, appImageName);
}

/** Writes the README beside the AppImages among `artifactPaths` and returns the files written. */
export function writeAppImageReadmes(artifactPaths: readonly string[]): string[] {
  const byDirectory = new Map<string, string[]>();
  for (const artifact of artifactPaths) {
    if (!artifact.endsWith('.AppImage')) continue;
    const names = byDirectory.get(dirname(artifact)) ?? [];
    names.push(basename(artifact));
    byDirectory.set(dirname(artifact), names);
  }
  return [...byDirectory].map(([directory, names]) => {
    const readme = join(directory, APPIMAGE_README_NAME);
    writeFileSync(readme, appImageReadme(names.length === 1 ? (names[0] ?? ANY_APPIMAGE) : ANY_APPIMAGE));
    return readme;
  });
}

/** electron-builder hook; returned files are only uploaded if a build publishes, which no package script does. */
export function afterAllArtifactBuild(buildResult: { readonly artifactPaths: readonly string[] }): string[] {
  return writeAppImageReadmes(buildResult.artifactPaths);
}
