import { afterEach } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { InterleafAPI } from '@shared/types/api';

/**
 * The complete preload bridge double.
 *
 * Production always has the bridge, so every test does too: the shared setup
 * installs one double as `globalThis.interleafAPI` before any module loads,
 * and the renderer's `bridge` singleton captures it. Every method of the
 * contract is present and typed. A call the test did not stub throws and names
 * itself. Tests change behaviour only through `stubBridge`, which replaces
 * individual methods on that one double; the methods are restored after each
 * test, so the object the singleton holds never changes.
 */

function unstubbed(method: string): never {
  throw new Error(`The test did not stub interleafAPI.${method}.`);
}

/** A listener registration that records nothing and unsubscribes cleanly. */
function noSubscription(): () => void {
  return () => undefined;
}

/** Per-namespace replacements for individual bridge methods. */
export type BridgeStubs = {
  readonly [Namespace in keyof InterleafAPI]?: Partial<InterleafAPI[Namespace]>;
};

const app: InterleafAPI['app'] = {
  getInfo: () => unstubbed('app.getInfo'),
  exportDebugLog: () => unstubbed('app.exportDebugLog'),
  openExternal: () => unstubbed('app.openExternal'),
  onBeforeClose: () => noSubscription(),
};

const settings: InterleafAPI['settings'] = {
  /** A fresh profile: main answers with the defaults before anything is saved. */
  get: () => Promise.resolve(DEFAULT_APP_SETTINGS),
  /**
   * Settings writes are a side effect the UI performs on its own, on a queue
   * shared by every renderer test in the file, so the base answers them the way
   * main does — with the settings it was handed — rather than failing a case
   * that never asked about persistence. A test that is about persistence stubs
   * this itself.
   */
  update: (next) => Promise.resolve(next),
};

const onboarding: InterleafAPI['onboarding'] = {
  getLaunchState: () => unstubbed('onboarding.getLaunchState'),
};

const files: InterleafAPI['files'] = {
  openDialog: () => unstubbed('files.openDialog'),
  openPending: () => Promise.resolve(null),
  onCommand: () => noSubscription(),
};

const reader: InterleafAPI['reader'] = {
  renderMermaid: () => unstubbed('reader.renderMermaid'),
};

const library: InterleafAPI['library'] = {
  importDroppedFiles: () => unstubbed('library.importDroppedFiles'),
  openFileDialog: () => unstubbed('library.openFileDialog'),
  importWebArticle: () => unstubbed('library.importWebArticle'),
  listDocuments: () => unstubbed('library.listDocuments'),
  openDocument: () => unstubbed('library.openDocument'),
  closeDocument: () => unstubbed('library.closeDocument'),
  deleteDocument: () => unstubbed('library.deleteDocument'),
  getContinueReading: () => unstubbed('library.getContinueReading'),
  getRecentlyAdded: () => unstubbed('library.getRecentlyAdded'),
  getRecentlyRead: () => unstubbed('library.getRecentlyRead'),
  getSummary: () => unstubbed('library.getSummary'),
  createFolder: () => unstubbed('library.createFolder'),
  renameFolder: () => unstubbed('library.renameFolder'),
  deleteFolder: () => unstubbed('library.deleteFolder'),
  listFolders: () => unstubbed('library.listFolders'),
  getFolderTree: () => unstubbed('library.getFolderTree'),
  moveDocumentToFolder: () => unstubbed('library.moveDocumentToFolder'),
  updateReadingPosition: () => unstubbed('library.updateReadingPosition'),
  getDocumentPreview: () => unstubbed('library.getDocumentPreview'),
  onStorageHealthUpdated: () => noSubscription(),
};

const annotations: InterleafAPI['annotations'] = {
  create: () => unstubbed('annotations.create'),
  list: () => unstubbed('annotations.list'),
  page: () => unstubbed('annotations.page'),
  update: () => unstubbed('annotations.update'),
  delete: () => unstubbed('annotations.delete'),
  repairAnchor: () => unstubbed('annotations.repairAnchor'),
};

const search: InterleafAPI['search'] = {
  beginIndex: () => unstubbed('search.beginIndex'),
  appendIndex: () => unstubbed('search.appendIndex'),
  completeIndex: () => unstubbed('search.completeIndex'),
  failIndex: () => unstubbed('search.failIndex'),
  getIndexState: () => unstubbed('search.getIndexState'),
  searchDocument: () => unstubbed('search.searchDocument'),
  resolveHit: () => unstubbed('search.resolveHit'),
};

const ai: InterleafAPI['ai'] = {
  listProviders: () => unstubbed('ai.listProviders'),
  getProviderStatus: () => unstubbed('ai.getProviderStatus'),
  signInWithChatGPT: () => unstubbed('ai.signInWithChatGPT'),
  listOpenRouterModels: () => unstubbed('ai.listOpenRouterModels'),
  configureOpenRouter: () => unstubbed('ai.configureOpenRouter'),
};

const credentials: InterleafAPI['credentials'] = {
  getOpenRouterStatus: () => unstubbed('credentials.getOpenRouterStatus'),
  clearOpenRouterKey: () => unstubbed('credentials.clearOpenRouterKey'),
  testOpenRouterConnection: () => unstubbed('credentials.testOpenRouterConnection'),
};

const chat: InterleafAPI['chat'] = {
  createSession: () => unstubbed('chat.createSession'),
  getSession: () => unstubbed('chat.getSession'),
  listSessions: () => unstubbed('chat.listSessions'),
  updateSession: () => unstubbed('chat.updateSession'),
  deleteSession: () => unstubbed('chat.deleteSession'),
  listMessages: () => unstubbed('chat.listMessages'),
  listContext: () => unstubbed('chat.listContext'),
  attachContext: () => unstubbed('chat.attachContext'),
  removeContext: () => unstubbed('chat.removeContext'),
  cleanContext: () => unstubbed('chat.cleanContext'),
  sendMessage: () => unstubbed('chat.sendMessage'),
  cancel: () => unstubbed('chat.cancel'),
  resolveCitation: () => unstubbed('chat.resolveCitation'),
  /**
   * The chat panel reads the budget on its own whenever a conversation is
   * bound, so the base answers as main does when it cannot size one.
   */
  getContextBudget: () => Promise.resolve(null),
  onStreamEvent: () => noSubscription(),
  onSessionTitleChanged: () => noSubscription(),
};

const agent: InterleafAPI['agent'] = {
  listProfiles: () => unstubbed('agent.listProfiles'),
  listProfileStatus: () => unstubbed('agent.listProfileStatus'),
  refreshModels: () => unstubbed('agent.refreshModels'),
  listWorkingDirectories: () => unstubbed('agent.listWorkingDirectories'),
  selectWorkingDirectory: () => unstubbed('agent.selectWorkingDirectory'),
  startSession: () => unstubbed('agent.startSession'),
  resumeSession: () => unstubbed('agent.resumeSession'),
  stopSession: () => unstubbed('agent.stopSession'),
  getSession: () => unstubbed('agent.getSession'),
  listSessions: () => unstubbed('agent.listSessions'),
  copyResult: () => unstubbed('agent.copyResult'),
  issueRiskGrant: () => unstubbed('agent.issueRiskGrant'),
  getEnvironmentReview: () => unstubbed('agent.getEnvironmentReview'),
  applyChanges: () => unstubbed('agent.applyChanges'),
  discardSandbox: () => unstubbed('agent.discardSandbox'),
  exportPatch: () => unstubbed('agent.exportPatch'),
  openFolder: () => unstubbed('agent.openFolder'),
  claimSession: () => unstubbed('agent.claimSession'),
  getModeAvailability: () => unstubbed('agent.getModeAvailability'),
  selectExecutable: () => unstubbed('agent.selectExecutable'),
  listCustomProfiles: () => unstubbed('agent.listCustomProfiles'),
  createCustomProfile: () => unstubbed('agent.createCustomProfile'),
  updateCustomProfile: () => unstubbed('agent.updateCustomProfile'),
  deleteCustomProfile: () => unstubbed('agent.deleteCustomProfile'),
  onEvent: () => noSubscription(),
};

const clipboard: InterleafAPI['clipboard'] = {
  writeText: () => unstubbed('clipboard.writeText'),
};

const updates: InterleafAPI['updates'] = {
  getState: () => unstubbed('updates.getState'),
  check: () => unstubbed('updates.check'),
  download: () => unstubbed('updates.download'),
  restart: () => unstubbed('updates.restart'),
  openReleasePage: () => unstubbed('updates.openReleasePage'),
  onState: () => noSubscription(),
};

function buildApi(overrides: BridgeStubs): InterleafAPI {
  return {
    app: { ...app, ...overrides.app },
    settings: { ...settings, ...overrides.settings },
    onboarding: { ...onboarding, ...overrides.onboarding },
    library: { ...library, ...overrides.library },
    files: { ...files, ...overrides.files },
    reader: { ...reader, ...overrides.reader },
    annotations: { ...annotations, ...overrides.annotations },
    search: { ...search, ...overrides.search },
    ai: { ...ai, ...overrides.ai },
    credentials: { ...credentials, ...overrides.credentials },
    chat: { ...chat, ...overrides.chat },
    agent: { ...agent, ...overrides.agent },
    clipboard: { ...clipboard, ...overrides.clipboard },
    updates: { ...updates, ...overrides.updates },
  };
}

/**
 * A standalone API double for a component that takes the API as a prop rather
 * than reading the bridge. Each namespace's overrides are laid over the
 * complete base, so TypeScript checks every stub against the real signature.
 */
export function testInterleafApi(overrides: BridgeStubs = {}): InterleafAPI {
  return buildApi(overrides);
}

/** The one installed bridge double, for assertions and spies. */
export const testBridge: InterleafAPI = buildApi({});

/**
 * Replaces individual methods on the installed double for the current test.
 * Every stub is undone after the test by `restoreBridge`.
 */
export function stubBridge(stubs: BridgeStubs): InterleafAPI {
  for (const namespace of Object.keys(stubs) as (keyof InterleafAPI)[]) {
    Object.assign(testBridge[namespace], stubs[namespace]);
  }
  return testBridge;
}

/** Puts every method of the installed double back to its base behaviour. */
function restoreBridge(): void {
  const base = buildApi({});
  for (const namespace of Object.keys(base) as (keyof InterleafAPI)[]) {
    Object.assign(testBridge[namespace], base[namespace]);
  }
}

/**
 * Installs the double as the preload would, then restores it after each test.
 * The shared setup calls this once per test file, before any module loads.
 */
export function installTestBridge(): void {
  Object.defineProperty(globalThis, 'interleafAPI', { configurable: true, value: testBridge });
  afterEach(restoreBridge);
}
