// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentProfile, AgentSessionDetail, AgentWorkingDirectory } from '@shared/types/agent';
import type { DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';
import { AGENT_MAX_CONTEXT_PACKET_BYTES } from '@shared/schemas/agent';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
const testProfile: AgentProfile = {
  id: 'codex',
  providerId: 'codex',
  name: 'Codex CLI',
  defaultModel: null,
  availableModels: [],
  reasoningEffort: null,
  defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true,
    sessionResume: true,
    nativeSandbox: true,
    workingDirectory: true,
    modelSelection: true,
    reasoningSelection: true,
    fileChangeEvents: true,
    toolEvents: true,
    subagents: true,
    interactiveAuthentication: true,
    nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false,
  unsafe: false,
};

const pdfDocument: DocumentMetadata = {
  id: 'doc-pdf-1',
  title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 12_000_000,
  fileMtimeMs: Date.now(),
  fileHash: 'hash-pdf-1',
  pageCount: 560,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: null,
};

const markdownDocument: DocumentMetadata = {
  id: 'doc-md-1',
  title: 'Architecture Decision Records',
  author: 'Engineering Team',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 45_000,
  fileMtimeMs: Date.now(),
  fileHash: 'hash-md-1',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: null,
};

/** One extracted chunk of the markdown fixture, complete as the reader emits it. */
function markdownChunk(ordinal: number, text: string): NormalizedTextChunk {
  return {
    id: `chunk-${String(ordinal)}`,
    documentId: markdownDocument.id,
    ordinal,
    text,
    tokenCount: Math.ceil(text.length / 4),
    location: { format: 'markdown', blockIndex: ordinal },
    heading: null,
    pageLabel: null,
  };
}

const defaultWorkspace: AgentWorkingDirectory = {
  handle: 'ws-default-handle',
  displayName: 'Interleaf Monorepo',
};

const secondaryWorkspace: AgentWorkingDirectory = {
  handle: 'ws-secondary-handle',
  displayName: 'Docs Repository',
};

function createTestSession(patch: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id: 'test-session-1',
    documentId: pdfDocument.id,
    profileId: testProfile.id,
    providerId: 'codex',
    targetDirectory: defaultWorkspace,
    executionMode: 'isolated-worktree',
    status: 'running',
    providerSessionId: 'prov-1',
    userPrompt: 'Test user prompt',
    contextSummary: null,
    effectiveModel: null,
    effectiveReasoningEffort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finalReport: null,
    environment: null,
    eventCount: 1,
    events: [],
    artifacts: [],
    ...patch,
  };
}
/** A hydrated composer with the test profile selected and the default workspace chosen. */
function ready(overrides: Partial<ReturnType<typeof useAgentStore.getState>> = {}): void {
  useAgentStore.setState({
    profiles: [testProfile],
    selectedProfileId: testProfile.id,
    workingDirectory: defaultWorkspace,
    workingDirectories: [defaultWorkspace],
    hydrated: true,
    ...overrides,
  });
}

describe('AgentComposer - Agent UX Batch Requirements', () => {
  afterEach(() => {
    cleanup();
    useAgentStore.setState({
      profiles: [],
      modeAvailability: [],
      selectedProfileId: null,
      workingDirectory: null,
      workingDirectories: [],
      workingDirectorySource: 'none',
      workingDirectoryDefaults: {},
      globalDefaultWorkingDirectory: null,
      contextPacket: null,
      activeSession: null,
      sessions: [],
      events: [],
      loading: false,
      error: null,
      hydrated: false,
    });
    useReaderStore.setState({
      session: null,
      currentPage: 1,
      explicitNavigationLocation: null,
    });
    useAnnotationStore.setState({
      selection: null,
    });
    useUiStore.setState({
      composer: { executionMode: 'auto-isolated', taskDraft: '' },
      loadedSettings: null,
    });
  });

  // ---------------------------------------------------------------------------
  // REQUIREMENT 1: Agent Context Controls
  // ---------------------------------------------------------------------------
  describe('Requirement 1: Document context attachment controls', () => {
    it('shows context attachment options when a PDF document is open and context is not yet attached', () => {
      useReaderStore.setState({ session: testReaderSession(pdfDocument), currentPage: 42 });
      ready();

      render(<AgentComposer />);

      expect(screen.getByTestId('agent-context-section')).toBeTruthy();
      expect(screen.getByTestId('agent-no-context-notice')).toHaveTextContent('No document attached. Nothing from it is sent unless you add it.');
      expect(screen.getByTestId('agent-pages-trigger')).toBeTruthy();
      expect(screen.getByTestId('agent-attach-entire-doc')).toBeTruthy();
    });

    it('draws the same "Entire document" chip and meta line as Reader Chat', () => {
      useReaderStore.setState({ session: testReaderSession(pdfDocument), currentPage: 42 });
      ready();

      render(<AgentComposer />);

      // One shared component (`WholeDocumentChip`): label, glyph and shape match
      // Chat's `chat-whole-document-toggle`; the note is the shared meta style.
      const chip = screen.getByTestId('agent-attach-entire-doc');
      expect(chip).toHaveClass('companion-whole-doc');
      expect(chip).toHaveTextContent(/^Entire document$/);
      expect(chip).toHaveAttribute('data-attached', 'false');
      expect(chip.querySelector('svg')).not.toBeNull();
      expect(screen.getByTestId('agent-no-context-notice')).toHaveClass('companion-meta');
      expect(screen.getByTestId('agent-no-context-notice')).not.toHaveClass('agent-mono');
    });

    it('attaches reader selected text when clicked, displays summary card, and allows removal', async () => {
      useReaderStore.setState({ session: testReaderSession(pdfDocument), currentPage: 10 });
      useAnnotationStore.setState({
        selection: {
          selectedText: 'Distributed transactions require two-phase commit consensus protocols.',
          totalSelectedLength: 70,
          chatDescriptor: {
            format: 'pdf',
            startPageIndex: 9,
            endPageIndex: 9,
            selectedTextSnippet: 'Distributed transactions require two-phase commit consensus protocols.',
          },
          anchor: {
            format: 'pdf',
            quote: { exact: 'Distributed transactions require two-phase commit consensus protocols.', prefix: 'In chapter 9, ', suffix: ' to ensure atomicity.' },
            pageIndex: 9,
            pageLabel: '10',
          },
          clientRect: { left: 100, top: 200, width: 300, height: 20 },
        },
      });
      ready();

      render(<AgentComposer />);

      const attachSelectionButton = screen.getByTestId('agent-attach-selection');
      expect(attachSelectionButton).toHaveTextContent('+ Selection');

      fireEvent.click(attachSelectionButton);

      // Should now display attached context summary
      const summary = await screen.findByTestId('agent-context-summary');
      expect(summary).toHaveTextContent('Designing Data-Intensive Applications');
      expect(summary).toHaveTextContent('Distributed transactions require two-phase commit');
      expect(useAgentStore.getState().contextPacket).toMatchObject({
        document: { id: 'doc-pdf-1', title: 'Designing Data-Intensive Applications' },
        selection: { exactQuote: 'Distributed transactions require two-phase commit consensus protocols.' },
        provenance: { contentIsUntrustedReference: true },
      });

      // Remove context
      const removeButton = screen.getByTestId('agent-remove-context');
      fireEvent.click(removeButton);

      expect(screen.queryByTestId('agent-context-summary')).toBeNull();
      expect(useAgentStore.getState().contextPacket).toBeNull();
    });

    it('attaches a PDF page range with bounds validation and untrusted reference provenance', async () => {
      const adapter = testDocumentAdapter('pdf', {
        extractText: async function* () {
          await Promise.resolve();
          yield {
            id: 'chunk-15',
            documentId: pdfDocument.id,
            ordinal: 14,
            text: 'Page fifteen text.',
            tokenCount: 3,
            location: { format: 'pdf' as const, pageIndex: 14 },
            heading: null,
            pageLabel: '15',
          };
        },
      });
      useReaderStore.setState({ session: testReaderSession(pdfDocument, { adapter }), currentPage: 15 });
      ready();

      render(<AgentComposer />);

      const pagesTrigger = screen.getByTestId('agent-pages-trigger');
      fireEvent.click(pagesTrigger);

      expect(screen.getByRole('dialog', { name: 'Add pages to agent context' })).toBeTruthy();

      const submitButton = screen.getByTestId('agent-pages-submit');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(useAgentStore.getState().contextPacket).toMatchObject({
          document: { id: 'doc-pdf-1', title: 'Designing Data-Intensive Applications' },
          selection: { location: { format: 'pdf', pageIndex: 14 } },
          provenance: { contentIsUntrustedReference: true },
        });
      });
    });

    it('fits a selection at the 256,000-character limit within the serialized packet budget', () => {
      const exactBoundaryText = 'B'.repeat(256_000);
      useReaderStore.setState({ session: testReaderSession(markdownDocument) });
      ready();

      useAgentStore.getState().setSelection(
        markdownDocument,
        { format: 'markdown', quote: { exact: exactBoundaryText, prefix: '', suffix: '' }, blockIndex: 0, lineIndex: 0 },
        exactBoundaryText,
      );

      const packet = useAgentStore.getState().contextPacket;
      expect(packet?.provenance.truncated).toBe(true);
      expect(packet?.selection.exactQuote.length).toBeLessThan(256_000);
      expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);

      render(<AgentComposer />);
      const summary = screen.getByTestId('agent-context-summary');
      expect(summary.textContent).toContain('truncated');
      const exactLength = packet?.selection.exactQuote.length ?? 0;
      expect(summary.textContent).toContain(`${exactLength.toLocaleString()} chars`);
    });

    it.each([
      // 100,000 + '\n\n' + 155,998 = exactly 256,000 source characters: within
      // the source limit, but the serialized packet budget still truncates.
      { name: 'at the source limit', chunks: ['F'.repeat(100_000), 'G'.repeat(155_998)] },
      { name: 'with overflow', chunks: ['F'.repeat(100_000), 'G'.repeat(155_998), 'H'.repeat(50)] },
    ])('attaches entire document context across multiple chunks $name and labels as truncated', async ({ chunks }) => {
      useReaderStore.setState({
        session: testReaderSession(markdownDocument, { adapter: testDocumentAdapter('markdown', {
          extractText: async function* () {
            await Promise.resolve();
            for (const [index, chunk] of chunks.entries()) yield markdownChunk(index, chunk);
          },
        }) }),
      });
      ready();

      render(<AgentComposer />);

      const attachEntireDocButton = screen.getByTestId('agent-attach-entire-doc');
      fireEvent.click(attachEntireDocButton);

      await waitFor(() => {
        const packet = useAgentStore.getState().contextPacket;
        expect(packet?.selection.exactQuote.length).toBeLessThan(256_000);
        expect(packet?.provenance.truncated).toBe(true);
      });

      expect(screen.getByTestId('agent-context-summary').textContent).toContain('truncated');
    });
  });
  // ---------------------------------------------------------------------------
  // REQUIREMENT 2: Default Workspace Setting & Hydration
  // ---------------------------------------------------------------------------
  describe('Requirement 2: Default workspace setting and auto-initialization', () => {
    it('initializes and selects the global default workspace across hydration', async () => {
      const appSettings: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        agent: {
          ...DEFAULT_APP_SETTINGS.agent,
          defaultWorkingDirectory: defaultWorkspace.handle,
          workingDirectories: [defaultWorkspace, secondaryWorkspace],
        },
      };

      const api = testInterleafApi({
        agent: {
          listProfiles: vi.fn(() => Promise.resolve([testProfile])),
          listSessions: vi.fn(() => Promise.resolve([])),
          listWorkingDirectories: vi.fn(() => Promise.resolve([defaultWorkspace, secondaryWorkspace])),
          getModeAvailability: vi.fn(() => Promise.resolve([])),
          onEvent: vi.fn(() => () => undefined),
        },
        settings: {
          get: vi.fn(() => Promise.resolve(appSettings)),
        },
      });
      stubBridge(api);

      render(<AgentComposer />);

      await waitFor(() => {
        expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('Interleaf Monorepo');
        expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Default workspace');
      });
    });

    it('gracefully clears and falls back to none if the default workspace handle is stale or removed', async () => {
      const appSettings: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        agent: {
          ...DEFAULT_APP_SETTINGS.agent,
          defaultWorkingDirectory: 'removed-stale-handle',
          workingDirectories: [secondaryWorkspace],
        },
      };

      const api = testInterleafApi({
        agent: {
          listProfiles: vi.fn(() => Promise.resolve([testProfile])),
          listSessions: vi.fn(() => Promise.resolve([])),
          listWorkingDirectories: vi.fn(() => Promise.resolve([secondaryWorkspace])),
          getModeAvailability: vi.fn(() => Promise.resolve([])),
          onEvent: vi.fn(() => () => undefined),
        },
        settings: {
          get: vi.fn(() => Promise.resolve(appSettings)),
        },
      });
      stubBridge(api);

      render(<AgentComposer />);

      await waitFor(() => {
        expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('No folder selected');
        expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Not selected');
      });
      // Folder guidance for the reader, not IPC implementation detail.
      expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Choose the project folder the agent should work in.');
      expect(screen.getByTestId('agent-working-directory-source')).not.toHaveTextContent(/IPC|handle/);
    });

    it('allows per-session override via directory selection', async () => {
      ready({
        workingDirectory: defaultWorkspace,
        workingDirectories: [defaultWorkspace, secondaryWorkspace],
        workingDirectorySource: 'global-default',
      });

      const api = testInterleafApi({
        agent: {
          selectWorkingDirectory: vi.fn(() => Promise.resolve(secondaryWorkspace)),
          getModeAvailability: vi.fn(() => Promise.resolve([])),
        },
      });
      stubBridge(api);

      render(<AgentComposer />);

      expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('Interleaf Monorepo');
      expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Default workspace');
      expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Agent runs start in this folder.');

      const chooseButton = screen.getByRole('button', { name: 'Choose…' });
      fireEvent.click(chooseButton);

      await waitFor(() => {
        expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('Docs Repository');
        expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Per-session override');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // REQUIREMENT 3: Human-Readable Agent Activity & No Raw JSON
  // ---------------------------------------------------------------------------
  describe('Requirement 3: Human-readable agent activity rendering', () => {
    it('renders high-signal assistant messages, commands, file changes, and todos without raw JSON envelopes', () => {
      const session = createTestSession({
        id: 'session-live-1',
        userPrompt: 'Implement high-signal activity renderer',
        effectiveModel: 'gpt-4o',
        eventCount: 6,
        events: [
          // Plumbing - MUST BE HIDDEN
          { sessionId: 'session-live-1', ordinal: 0, type: 'started', timestamp: '2026-08-26T18:00:00.000Z' },
          { sessionId: 'session-live-1', ordinal: 1, type: 'structured', data: { type: 'thread.started', thread_id: 'thr_123' }, timestamp: '2026-08-26T18:00:01.000Z' },
          { sessionId: 'session-live-1', ordinal: 2, type: 'stdout', stream: 'stdout', text: '{"type":"thread.started","thread_id":"thr_123"}', timestamp: '2026-08-26T18:00:01.000Z' },
          // Assistant message
          { sessionId: 'session-live-1', ordinal: 3, type: 'structured', data: { type: 'item.started', item: { id: 'msg_1', type: 'agent_message', text: 'Inspecting codebase architecture...' } }, timestamp: '2026-08-26T18:00:02.000Z' },
          // Command execution
          { sessionId: 'session-live-1', ordinal: 4, type: 'structured', data: { type: 'item.completed', item: { id: 'cmd_1', type: 'command_execution', command: 'npm test', exit_code: 0, output: '10 tests passed' } }, timestamp: '2026-08-26T18:00:03.000Z' },
          // File changes with line counts
          { sessionId: 'session-live-1', ordinal: 5, type: 'structured', data: { type: 'item.completed', item: { id: 'fc_1', type: 'file_change', path: 'src/app.ts', status: 'modified', additions: 4, deletions: 5 } }, timestamp: '2026-08-26T18:00:04.000Z' },
        ],
      });
      ready({
        activeSession: session,
        sessions: [session],
        events: session.events,
      });

      const { container } = render(<AgentComposer />);

      // Verify protocol plumbing and raw JSON envelopes are NOT visible in the DOM
      expect(screen.queryByText('thread.started')).toBeNull();
      expect(screen.queryByText('thr_123')).toBeNull();
      expect(container.textContent).not.toContain('{"type":"thread.started"');

      // Verify high-signal items are rendered
      expect(screen.getByTestId('activity-message-msg_1')).toHaveTextContent('Inspecting codebase architecture...');
      expect(screen.getByTestId('activity-command-cmd_1')).toHaveTextContent('$npm test');
      expect(screen.getByTestId('activity-command-cmd_1')).toHaveTextContent('Exit 0');
      expect(screen.getByTestId('activity-file-fc_1:src/app.ts')).toHaveTextContent('src/app.ts');
      expect(screen.getByTestId('activity-file-fc_1:src/app.ts')).toHaveTextContent('+4');
      expect(screen.getByTestId('activity-file-fc_1:src/app.ts')).toHaveTextContent('-5');
    });

    it('safely renders untrusted text without executing HTML or script injections', () => {
      const maliciousText = '<img src=x onerror="alert(1)"> <script>alert("hack")</script>';
      const session = createTestSession({
        id: 'session-sec-1',
        providerSessionId: 'prov-sec',
        userPrompt: 'Security test',
        eventCount: 2,
        events: [
          { sessionId: 'session-sec-1', ordinal: 0, type: 'started', timestamp: '2026-08-26T18:00:00.000Z' },
          { sessionId: 'session-sec-1', ordinal: 1, type: 'structured', data: { type: 'item.completed', item: { id: 'msg_sec', type: 'agent_message', text: maliciousText } }, timestamp: '2026-08-26T18:00:01.000Z' },
        ],
      });
      ready({
        activeSession: session,
        sessions: [session],
        events: session.events,
      });

      const { container } = render(<AgentComposer />);

      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('script')).toBeNull();
      expect(screen.getByTestId('activity-message-msg_sec')).toHaveTextContent(maliciousText);
    });
  });

  // ---------------------------------------------------------------------------
  // REQUIREMENT 4: Active-Session Takeover & Back Action
  // ---------------------------------------------------------------------------
  describe('Requirement 4: Active-session takeover and Back navigation', () => {
    it('takes over the composer area when a session is running and allows Back navigation to return to composer and session list', () => {
      const runningSession = createTestSession({
        id: 'session-running-1',
        providerSessionId: 'prov-run-1',
        userPrompt: 'Refactor database client',
        effectiveModel: 'gpt-4o',
        events: [
          { sessionId: 'session-running-1', ordinal: 0, type: 'started', timestamp: new Date().toISOString() },
        ],
      });
      ready({
        activeSession: runningSession,
        sessions: [runningSession],
        events: runningSession.events,
      });

      render(<AgentComposer />);

      // Active session takeover: composer form is hidden, live session view is displayed
      expect(screen.queryByLabelText('Task description')).toBeNull();
      expect(screen.getByTestId('agent-active-session-title')).toHaveTextContent('Refactor database client');
      expect(screen.getByTestId('agent-stop-button')).toBeTruthy();
      expect(screen.getByTestId('agent-activity-list')).toBeTruthy();

      // Back action
      const backButton = screen.getByTestId('agent-back-button');
      expect(backButton).toHaveTextContent('New task');
      expect(backButton).toHaveAccessibleName('Back to all sessions and new task');

      fireEvent.click(backButton);

      // Returning to composer view
      expect(screen.getByLabelText('Task description')).toBeTruthy();
      expect(screen.getByTestId('agent-start-button')).toBeTruthy();
      expect(screen.getByTestId('agent-session-list')).toBeTruthy();
    });

    it('allows deterministic navigation for terminal sessions without trapping the user', () => {
      const completedSession = createTestSession({
        id: 'session-done-1',
        status: 'completed',
        providerSessionId: 'prov-done-1',
        userPrompt: 'Add unit tests',
        finalReport: 'All tests added and verified.',
        eventCount: 2,
        events: [
          { sessionId: 'session-done-1', ordinal: 0, type: 'started', timestamp: new Date().toISOString() },
          { sessionId: 'session-done-1', ordinal: 1, type: 'final', text: 'All tests added and verified.', timestamp: new Date().toISOString() },
        ],
      });
      ready({
        activeSession: completedSession,
        sessions: [completedSession],
        events: completedSession.events,
      });

      render(<AgentComposer />);

      expect(screen.getByTestId('agent-final-report')).toHaveTextContent('All tests added and verified.');
      const backButton = screen.getByTestId('agent-back-button');
      fireEvent.click(backButton);

      expect(useAgentStore.getState().activeSession).toBeNull();
      expect(screen.getByLabelText('Task description')).toBeTruthy();
    });
  });
});
