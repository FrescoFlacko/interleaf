// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_AGENT_EXECUTION_MODE } from "@shared/constants/agent-modes";
import { DEFAULT_SELECTABLE_EXECUTION_MODE } from "@shared/constants/agent-mode-selection";
import { DEFAULT_PALETTE } from "@shared/constants/palettes";
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from "@shared/schemas/settings";
import type { AppSettings } from "@shared/schemas/settings";
import type { z } from "zod";
import type { AppInfo } from "@shared/schemas/ipc";
import type { AgentProfile } from "@shared/types/agent";
import { App } from "../../src/renderer/app/App";
import { useUiStore } from "../../src/renderer/stores/use-ui-store";
import { useReaderStore } from "../../src/renderer/stores/use-reader-store";
import { type BridgeStubs, stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { chooseValue } from '../helpers/listbox-select';

// The renderer's bridge singleton holds the shared double, so stubbing its
// methods before every render changes what the app sees on mount.
const updateCalls: AppSettings[] = [];
let settingsGetCalls = 0;
/** The stored document this launch hydrates from, when a test needs its own. */
let storedSettings: AppSettings = DEFAULT_APP_SETTINGS;

const APP_INFO: AppInfo = {
  name: "Interleaf",
  tagline: "Read. Think. Build.",
  version: "0.2.0",
  platform: "darwin",
  versions: { electron: "43.0.0", node: "24.0.0", chrome: "140.0.0" },
};

function installAppBridge(agentProfiles: readonly AgentProfile[] = []): void {
  const api: BridgeStubs = {
    app: {
      getInfo: () => {
        return Promise.resolve(APP_INFO);
      },
      exportDebugLog: () => Promise.resolve({ status: "cancelled" as const }),
      openExternal: () => Promise.resolve({ opened: true }),
      onBeforeClose: () => () => undefined,
    },
    onboarding: {
      getLaunchState: () => Promise.resolve({
        verdict: 'done' as const,
        shouldAutoOpen: false,
        resumeStage: 'welcome' as const,
        settingsRowPresent: true,
        onboardingSectionPresent: true,
        priorInstallEvidence: true,
      }),
    },
    settings: {
      get: () => {
        settingsGetCalls += 1;
        return Promise.resolve(structuredClone(storedSettings));
      },
      update: (next: AppSettings) => {
        updateCalls.push(structuredClone(next));
        return Promise.resolve(next);
      },
    },
    library: {
      importDroppedFiles: () => Promise.resolve({ imported: [], failed: [], totalAttempted: 0 }),
      openFileDialog: () => Promise.resolve({ imported: [], failed: [], totalAttempted: 0 }),
      importWebArticle: () => Promise.reject(new Error('not implemented')),
      listDocuments: () => Promise.resolve([]),
      openDocument: () => Promise.reject(new Error('not implemented')),
      closeDocument: () => Promise.resolve(),
      deleteDocument: () => Promise.resolve(),
      getContinueReading: () => Promise.resolve([]),
      getRecentlyAdded: () => Promise.resolve([]),
      getRecentlyRead: () => Promise.resolve([]),
      getSummary: () =>
        Promise.resolve({
          totalDocuments: 0,
          formatCounts: { pdf: 0, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
          managedCount: 0,
          linkCount: 0,
          missingCount: 0,
          changedCount: 0,
          totalFolders: 0,
        }),
      createFolder: (name, parentId) =>
        Promise.resolve({
          id: 'test-folder-id',
          name,
          parentId: parentId ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documentCount: 0,
        }),
      renameFolder: (id, name) =>
        Promise.resolve({
          id,
          name,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documentCount: 0,
        }),
      deleteFolder: () => Promise.resolve(),
      listFolders: () => Promise.resolve([]),
      getFolderTree: () => Promise.resolve([]),
      moveDocumentToFolder: () => Promise.resolve(),
      updateReadingPosition: (_documentId, location, progress) =>
        Promise.resolve({
          location,
          progress,
          updatedAt: new Date().toISOString(),
        }),
      getDocumentPreview: (documentId) =>
        Promise.resolve({
          documentId,
          format: 'pdf',
          locationLabel: 'Page 1',
          isLastRead: false,
          snippet: 'Sample preview snippet',
          coverAssetUrl: null,
          fallback: false,
        }),
      onStorageHealthUpdated: () => () => undefined,
    },
    annotations: {
      create: () => Promise.reject(new Error('not implemented')),
      list: () => Promise.resolve([]),
      page: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 50 }),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(null),
      repairAnchor: () => Promise.resolve(null),
    },
    search: {
      beginIndex: () => Promise.reject(new Error('not implemented')),
      appendIndex: () => Promise.reject(new Error('not implemented')),
      completeIndex: () => Promise.reject(new Error('not implemented')),
      failIndex: () => Promise.reject(new Error('not implemented')),
      getIndexState: () => Promise.resolve(null),
      searchDocument: () => Promise.resolve([]),
      resolveHit: () => Promise.resolve(null),
    },
    ai: {
      listProviders: () => Promise.resolve([]),
      getProviderStatus: () => Promise.reject(new Error('not implemented')),
      signInWithChatGPT: () => Promise.reject(new Error('not implemented')),
      listOpenRouterModels: () => Promise.resolve([]),
      configureOpenRouter: () => Promise.reject(new Error('not implemented')),
    },
    credentials: {
      getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS),
      clearOpenRouterKey: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS),
      testOpenRouterConnection: () => Promise.resolve({ success: true, message: 'Connected' }),
    },
    chat: {
      createSession: () => Promise.reject(new Error('not implemented')),
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      updateSession: () => Promise.reject(new Error('not implemented')),
      deleteSession: () => Promise.resolve(),
      listMessages: () => Promise.resolve([]),
      listContext: () => Promise.resolve([]),
      getContextBudget: () => Promise.reject(new Error('not implemented')),
      attachContext: () => Promise.reject(new Error('not implemented')),
      removeContext: () => Promise.resolve(),
      cleanContext: (sessionId: string) =>
        Promise.resolve({
          sessionId,
          compactedThroughOrdinal: 0,
          summaryTextUnits: 1,
          clearedContextItemIds: [],
        }),
      sendMessage: () => Promise.reject(new Error('not implemented')),
      cancel: () => Promise.resolve(),
      resolveCitation: () => Promise.resolve(null),
      onStreamEvent: () => () => undefined,
    },
    agent: {
      listProfiles: () => Promise.resolve([...agentProfiles]),
      listProfileStatus: () => Promise.resolve({ profiles: [], modelDiscoveryPending: false }),
      refreshModels: () => Promise.resolve([]),
      listWorkingDirectories: () => Promise.resolve([]),
      selectWorkingDirectory: () => Promise.resolve(null),
      startSession: () => Promise.reject(new Error('not implemented')),
      resumeSession: () => Promise.reject(new Error('not implemented')),
      stopSession: () => Promise.resolve(),
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      copyResult: () => Promise.resolve({ copied: true, characterCount: 0 }),
      issueRiskGrant: () => Promise.reject(new Error('not implemented')),
      getEnvironmentReview: () => Promise.resolve(null),
      applyChanges: () => Promise.reject(new Error('not implemented')),
      discardSandbox: () => Promise.resolve(),
      exportPatch: () => Promise.reject(new Error('not implemented')),
      openFolder: () => Promise.resolve({ opened: false }),
      getModeAvailability: () => Promise.resolve([]),
      onEvent: () => () => undefined,
    },
    files: {
      openDialog: () => Promise.resolve(null),
      openPending: () => Promise.resolve(null),
      onCommand: () => () => undefined,
    },
    reader: {
      renderMermaid: () => Promise.resolve({ status: 'failed', reason: 'unavailable' } as const),
    },
    clipboard: {
      writeText: () => Promise.resolve({ copied: true, characterCount: 0 }),
    },
  };
  stubBridge(api);
}

function resetStore(): void {
  useUiStore.setState({
    leftOpen: true,
    rightOpen: true,
    rightTab: "chat",
    focusMode: false,
    shortcutsOpen: false,
    palette: DEFAULT_PALETTE,
    composer: {
      executionMode: DEFAULT_AGENT_EXECUTION_MODE,
      taskDraft: "",
    },
    loadedAgentDefault: DEFAULT_SELECTABLE_EXECUTION_MODE,
    loadedSettings: null,
  });
  useReaderStore.setState({
    session: null,
    pageCount: 0,
    isLoading: false,
    error: null,
  });
}

const INSTALLED_FAKE_PROFILE: AgentProfile = {
  id: 'fake-installed', providerId: 'fake', name: 'Fake Agent', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-09-01T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

async function mountApp(agentProfiles: readonly AgentProfile[] = []): Promise<void> {
  installAppBridge(agentProfiles);
  render(<App />);
  await waitFor(() => { expect(screen.getByTestId("reader-viewport")).toBeTruthy(); });
}

describe("Interleaf renderer shell", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    settingsGetCalls = 0;
    storedSettings = DEFAULT_APP_SETTINGS;
    resetStore();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("renders header, library sidebar, reader viewport, and companion panel", async () => {
    await mountApp();
    expect(screen.getByTestId("app-header")).toBeTruthy();
    expect(screen.getByTestId("sidebar-library")).toBeTruthy();
    expect(screen.getByTestId("reader-viewport")).toBeTruthy();
    expect(screen.getByTestId("companion-panel")).toBeTruthy();
    await waitFor(() => { expect(settingsGetCalls).toBeGreaterThan(0); });
  });

  test("hydrates the saved Library defaults on launch", async () => {
    const { useLibraryStore } = await import("../../src/renderer/stores/use-library-store");
    storedSettings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      library: { defaultView: "list", defaultSort: "title_asc" },
    };

    await mountApp();

    await waitFor(() => {
      expect(useLibraryStore.getState().viewMode).toBe("list");
      expect(useLibraryStore.getState().sortBy).toBe("title_asc");
    });
    // Any launch-time settings write still carries the stored defaults back.
    const writtenLibraries = new Set(updateCalls.map((written) => JSON.stringify(written.library)));
    writtenLibraries.delete(JSON.stringify({ defaultView: "list", defaultSort: "title_asc" }));
    expect([...writtenLibraries]).toEqual([]);
  });

  test("F11 does not enter focus mode from the Library workspace", async () => {
    await mountApp();
    fireEvent.keyDown(window, { key: "F11" });
    expect(useUiStore.getState().focusMode).toBe(false);
    expect(screen.getByTestId("app-header")).toBeTruthy();
    expect(screen.queryByTestId("open-focus")).toBeNull();
    expect(screen.getByTestId("sidebar-library")).toBeTruthy();
    expect(screen.getByTestId("companion-panel")).toBeTruthy();
  });

  test("F11 remains unavailable from editable Library controls without an active reader", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    const task = screen.getByLabelText("Task description");
    task.focus();

    fireEvent.keyDown(task, { key: "F11" });
    expect(useUiStore.getState().focusMode).toBe(false);
    expect(screen.getByTestId("app-header")).toBeTruthy();
    expect(screen.queryByTestId("open-focus")).toBeNull();
  });

  test("reconciles stale Focus Mode state when the reader is no longer active", async () => {
    useUiStore.setState({ focusMode: true });
    await mountApp();

    await waitFor(() => { expect(useUiStore.getState().focusMode).toBe(false); });
    expect(screen.getByTestId("app-header")).toBeTruthy();
    expect(screen.queryByTestId("open-focus")).toBeNull();
  });

  test("shortcuts dialog traps focus, inerts the shell, closes, and restores focus", async () => {
    await mountApp();
    const opener = screen.getByRole("button", { name: "Show keyboard shortcuts" });
    opener.focus();
    fireEvent.click(opener);

    const shell = document.querySelector<HTMLElement>("[data-app-shell]");
    const close = screen.getByRole("button", { name: "Close keyboard shortcuts" });
    expect(shell).toHaveAttribute("inert");
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(screen.getByTestId("shortcuts-dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
    // The dialog fades out (100ms), inert while it leaves.
    await waitFor(() => {
      expect(screen.queryByTestId("shortcuts-dialog")).toBeNull();
    });
  });

  test("palette switch updates document theme and persists via settings.update", async () => {
    await mountApp();

    fireEvent.click(screen.getByTestId("theme-menu-trigger"));
    fireEvent.click(screen.getByTestId("palette-option-midnight"));

    expect(document.documentElement.dataset.theme).toBe("midnight");
    await waitFor(() =>
      { expect(updateCalls.some((next) => next.appearance.palette === "midnight")).toBe(true); },
    );
  });

  test("composer defaults to auto-isolated; direct modes carry no inline confirmation; switching back persists the default", async () => {
    // The run settings exist only once some agent is installed; with none, the
    // card is the install guidance instead.
    await mountApp([INSTALLED_FAKE_PROFILE]);

    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));

    const modeSelect = screen.getByTestId(
      "composer-execution-mode-select",
    );
    expect(modeSelect.dataset.value).toBe("auto-isolated");

    // Direct-workspace modes are confirmed by the native main-process dialog at
    // start time, so the composer must not carry an inline warning or checkbox.
    chooseValue(modeSelect, "active-env");
    expect(screen.queryByTestId("direct-workspace-warning")).toBeNull();
    expect(screen.queryByTestId("direct-workspace-confirm")).toBeNull();

    chooseValue(modeSelect, "isolated-worktree");
    await waitFor(() => {
      const last = updateCalls[updateCalls.length - 1];
      expect(last?.agent.defaultExecutionMode).toBe("isolated-worktree");
    });
    // Active Environment itself must never be persisted as the default.
    expect(
      updateCalls.some(
        (next) =>
          (next as { agent: { defaultExecutionMode: string } }).agent
            .defaultExecutionMode === "active-env",
      ),
    ).toBe(false);

    const callCount = updateCalls.length;
    chooseValue(modeSelect, "native-restricted");
    expect(updateCalls).toHaveLength(callCount);
    expect(screen.queryByTestId("direct-workspace-warning")).toBeNull();
  });

  test("skip link is the first focusable element in the shell and targets the stable main-content element", async () => {
    await mountApp();
    const skipLink = screen.getByTestId("skip-to-reader");
    expect(skipLink).toBeTruthy();
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(skipLink.textContent).toBe("Skip to main content");

    // Must be the first focusable control in DOM order before header buttons
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    expect(focusable[0]).toBe(skipLink);

    // Target #main-content must exist in Library state
    const mainContent = document.getElementById("main-content");
    expect(mainContent).toBeTruthy();
    expect(mainContent?.getAttribute("data-testid")).toBe("reader-viewport");

    // Activating skip link focuses main-content
    fireEvent.click(skipLink);
    expect(document.activeElement).toBe(mainContent);
  });
});

// The companion drawer opens at launch unless the profile opted out with
// `layout.openRightPanelOnStartup`. Only the first hydration is a launch: the
// drawer stays an ordinary, user-controlled panel once the app is running, and
// toggling it never changes the startup preference.
describe("launch layout", () => {
  const optedOut: AppSettings = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    // The drawer was last left open; the startup preference still wins.
    layout: { leftWidth: 300, rightWidth: 400, leftOpen: true, rightOpen: true, openRightPanelOnStartup: false },
  };
  const lastClosed: AppSettings = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    layout: { ...DEFAULT_APP_SETTINGS.layout, rightOpen: false },
  };
  // A document written before the startup preference existed.
  const legacyLayout: z.input<typeof appSettingsSchema>["layout"] = { leftWidth: 300, rightWidth: 400, leftOpen: true, rightOpen: false };
  const legacy = appSettingsSchema.parse({ ...structuredClone(DEFAULT_APP_SETTINGS), layout: legacyLayout });

  beforeEach(() => {
    updateCalls.length = 0;
    settingsGetCalls = 0;
    // A launch starts from the store's own initial state, not a test reset.
    useUiStore.setState(useUiStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    storedSettings = DEFAULT_APP_SETTINGS;
    resetStore();
  });

  function rightPanel(): HTMLElement {
    return screen.getByTestId("resizable-panel-right");
  }

  async function launch(stored: AppSettings): Promise<void> {
    storedSettings = stored;
    installAppBridge();
    render(<App />);
    // Collapsed until the startup preference is known, so an opted-out
    // profile never sees the drawer flash open.
    expect(rightPanel()).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => { expect(useUiStore.getState().loadedSettings).not.toBeNull(); });
  }

  test("holds the companion drawer collapsed until settings hydrate", () => {
    expect(useUiStore.getState().rightOpen).toBe(false);
    expect(useUiStore.getState().leftOpen).toBe(true);
  });

  test.each([
    ["a fresh profile", DEFAULT_APP_SETTINGS],
    ["a profile that last closed the drawer", lastClosed],
    ["a legacy profile without the startup preference", legacy],
  ])("opens the drawer after hydrating %s", async (_label, stored) => {
    await launch(stored);
    const state = useUiStore.getState();
    expect(state.rightOpen).toBe(true);
    await waitFor(() => { expect(rightPanel()).not.toHaveAttribute("aria-hidden"); });
    expect(state.loadedSettings?.layout).toMatchObject({ rightOpen: true, openRightPanelOnStartup: true });
    // The rest of the saved layout still applies.
    expect(state.leftOpen).toBe(stored.layout.leftOpen);
    expect(state.leftWidth).toBe(stored.layout.leftWidth);
    expect(state.rightWidth).toBe(stored.layout.rightWidth);
  });

  test("keeps the drawer collapsed for a profile that opted out, even if it was last left open", async () => {
    await launch(optedOut);
    const state = useUiStore.getState();
    expect(state.rightOpen).toBe(false);
    expect(rightPanel()).toHaveAttribute("aria-hidden", "true");
    expect(state.loadedSettings?.layout).toMatchObject({ rightOpen: false, openRightPanelOnStartup: false });
    expect(state.leftWidth).toBe(300);
    expect(state.rightWidth).toBe(400);
  });

  test("toggling the drawer persists its live state but never the startup preference", async () => {
    await launch(optedOut);

    fireEvent.click(screen.getByTestId("toggle-right-panel"));
    expect(useUiStore.getState().rightOpen).toBe(true);
    await waitFor(() => { expect(rightPanel()).not.toHaveAttribute("aria-hidden"); });
    await waitFor(() => { expect(updateCalls.at(-1)?.layout.rightOpen).toBe(true); });
    expect(updateCalls.every((written) => !written.layout.openRightPanelOnStartup)).toBe(true);
  });

  test.each([
    ["closed", DEFAULT_APP_SETTINGS],
    ["opened", optedOut],
  ])("a later hydration keeps a drawer the reader %s", async (_label, stored) => {
    await launch(stored);
    const before = useUiStore.getState().rightOpen;
    fireEvent.click(screen.getByTestId("toggle-right-panel"));
    const manual = useUiStore.getState().rightOpen;
    expect(manual).toBe(!before);

    // A stale read lands after the toggle; it must not reapply the launch rule.
    useUiStore.getState().hydrate(structuredClone(stored));
    expect(useUiStore.getState().rightOpen).toBe(manual);
    expect(useUiStore.getState().loadedSettings?.layout.rightOpen).toBe(manual);
    useUiStore.getState().hydrate({ ...structuredClone(stored), layout: { ...stored.layout, rightOpen: !manual, openRightPanelOnStartup: !manual } });
    expect(useUiStore.getState().rightOpen).toBe(manual);
  });

  test("a later settings load in the same session does not close a drawer the user opened", async () => {
    const { hydrateStoresFromLoad, withLiveLayout } = await import("../../src/renderer/features/settings/settings-store-sync");
    await launch(optedOut);

    useUiStore.getState().showRightTab("annotations");
    hydrateStoresFromLoad(optedOut, withLiveLayout(optedOut));

    expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: "annotations" });
    expect(useUiStore.getState().loadedSettings?.layout.rightOpen).toBe(true);
  });

  test("the General setting saves the startup preference without moving the live drawer", async () => {
    await launch(DEFAULT_APP_SETTINGS);
    expect(useUiStore.getState().rightOpen).toBe(true);

    useUiStore.getState().openSettings("general");
    const checkbox = await screen.findByRole("checkbox", { name: /Open AI drawer on startup/u });
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/Applies the next time Interleaf opens/u)).toBeTruthy();

    fireEvent.click(checkbox);
    await waitFor(() => { expect(updateCalls.at(-1)?.layout.openRightPanelOnStartup).toBe(false); });
    expect(updateCalls.at(-1)?.layout.rightOpen).toBe(true);
    expect(useUiStore.getState().rightOpen).toBe(true);
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => { expect(updateCalls.at(-1)?.layout.openRightPanelOnStartup).toBe(true); });
    expect(useUiStore.getState().rightOpen).toBe(true);
  });
});
