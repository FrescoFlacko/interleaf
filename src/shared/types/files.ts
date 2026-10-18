/**
 * What main may ask the renderer to do about files: show the Open dialog, show
 * the library import dialog, or open the file the operating system handed to
 * the application. The command never carries a path.
 */
export type FileCommand = 'open-dialog' | 'import-dialog' | 'open-pending';

const FILE_COMMANDS: readonly FileCommand[] = ['open-dialog', 'import-dialog', 'open-pending'];

export function isFileCommand(value: string): value is FileCommand {
  return FILE_COMMANDS.some((command) => command === value);
}
