import type { IpcDispatcherDeps } from '../../src/main/ipc/dispatcher';
import { createSenderRule } from '../../src/main/ipc/sender-validation';
import type { OpenFilesRuntime } from '../../src/main/open-files/open-file-routing';
import { silentLogger } from './silent-logger';
import { unstubbed } from './unstubbed';

/** The sender rule production builds for the packaged and dev renderer. */
export const testSenderRule = createSenderRule({
  indexHtmlPath: '/out/renderer/index.html',
  devUrl: 'http://localhost:5173',
});

/**
 * No file is open outside the library, which is the state every dispatcher
 * starts in: routing falls through to the library and shutdown has nothing to
 * close. Any other open-file call is a test that forgot to describe its files.
 */
function noOpenFiles(): OpenFilesRuntime {
  return unstubbed<OpenFilesRuntime>('openFiles', {
    forDocument: () => null,
    forSession: () => null,
    owns: () => false,
    closeAll: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
}

function notStubbed(name: string): () => never {
  return () => {
    throw new Error(`The test did not stub ${name}.`);
  };
}

/**
 * Complete dispatcher dependencies. Every collaborator is present; the ones a
 * test passes answer as written and any other one fails by name when a handler
 * reaches it, so a test states exactly the surface it exercises.
 */
export function makeIpcDeps(overrides: Partial<IpcDispatcherDeps> = {}): IpcDispatcherDeps {
  return {
    settings: unstubbed('settings'),
    onboardingLaunchState: notStubbed('onboardingLaunchState'),
    library: unstubbed('library'),
    annotations: unstubbed('annotations'),
    search: unstubbed('search'),
    chat: unstubbed('chat'),
    credentials: unstubbed('credentials'),
    appInfo: notStubbed('appInfo'),
    senderRule: testSenderRule,
    log: silentLogger,
    parentWindow: () => null,
    exportDebugLog: notStubbed('exportDebugLog'),
    openExternal: notStubbed('openExternal'),
    confirmExternalLink: notStubbed('confirmExternalLink'),
    applyDiagnosticLogging: notStubbed('applyDiagnosticLogging'),
    agent: unstubbed('agent'),
    confirmUnsafeProfile: notStubbed('confirmUnsafeProfile'),
    clipboard: unstubbed('clipboard'),
    mermaid: unstubbed('mermaid'),
    openFiles: noOpenFiles(),
    updates: unstubbed('updates'),
    ...overrides,
  };
}
