import { errorHasCode } from '@shared/models/caught-error';
import { app } from 'electron';
import { join } from 'node:path';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

/**
 * Application-managed storage locations under Electron's userData directory.
 * Everything Interleaf writes lives inside these roots (AGENTS.md §2 path
 * traversal guards rely on this containment).
 */
export type AppPaths = { readonly userData: string;
readonly database: string;
readonly library: string;
readonly aiChat: string;
readonly agentWorkspaces: string;
readonly agentContext: string;
readonly logs: string;
/** Main-owned staging for files opened without adding them to the library. */
readonly openFiles: string; }

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  const paths: AppPaths = {
    userData,
    database: join(userData, 'database'),
    library: join(userData, 'library'),
    aiChat: join(userData, 'ai-chat'),
    agentWorkspaces: join(userData, 'agent-workspaces'),
    agentContext: join(userData, 'agent-workspaces', 'context'),
    logs: join(userData, 'logs'),
    openFiles: join(userData, 'open-files'),
  };
  for (const dir of [paths.database, paths.library, paths.aiChat, paths.agentWorkspaces, paths.agentContext, paths.logs, paths.openFiles]) {
    ensurePrivateDirectory(dir);
  }
  return paths;
}

/**
 * Application-owned directories must never silently resolve through a symlink.
 * Existing directories are tightened to owner-only permissions; an unsafe
 * path fails closed before any database, credential, or log file is opened.
 */
function ensurePrivateDirectory(directory: string): void {
  if (!isPrivateDirectory(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory);
  }
  chmodSync(directory, 0o700);
}

/**
 * True once the directory exists and is safe. A path that does not exist yet is
 * simply absent; any other failure, including an unsafe path, still throws.
 */
function isPrivateDirectory(directory: string): boolean {
  try {
    assertPrivateDirectory(directory);
    return true;
  } catch (error) {
    if (errorHasCode(error instanceof Error ? error : null, 'ENOENT')) return false;
    throw error;
  }
}

/** Fails closed unless the path is a real directory rather than a symlink. */
function assertPrivateDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Application storage path is not a private directory: ${directory}`);
  }
}
