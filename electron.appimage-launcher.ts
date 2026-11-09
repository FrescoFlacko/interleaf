import { chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install our fail-closed launcher into the application directory before
 * electron-builder copies it over its generated AppRun into the AppImage. */
export function afterPack(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly targets: readonly { readonly name: string }[];
}): void {
  if (context.electronPlatformName !== 'linux' || !context.targets.some((target) => target.name === 'appImage')) return;
  const destination = join(context.appOutDir, 'AppRun');
  copyFileSync(fileURLToPath(new URL('./resources/linux/AppRun', import.meta.url)), destination);
  chmodSync(destination, 0o755);
}
