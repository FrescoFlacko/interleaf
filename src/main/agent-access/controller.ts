import type { BrowserWindow, Clipboard, Dialog, MessageBoxOptions } from 'electron';
import type { InterleafDatabase } from '../db/database';
import type { AnnotationRepository } from '../db/repositories/annotation-repository';
import type { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import type { SearchRepository } from '../db/repositories/search-repository';
import { LibraryReader } from './library-reader';
import { ProposalRepository, type ProposalAcceptHandlers } from './proposal-repository';
import { McpTools } from './mcp-tools';
import { McpServer } from './mcp-server';
import type { PassageReference } from './passage-link';
import type { AgentSource } from '@shared/schemas/agent-access';
import { InterleafError } from '@shared/errors/interleaf-error';
import { AgentAccessLifetime, awaitDialog } from './lifetime';
import { reviewProposals } from './proposal-review';

type Dependencies = {
  readonly database: InterleafDatabase;
  readonly search: SearchRepository;
  readonly annotations: AnnotationRepository;
  readonly positions: ReadingPositionRepository;
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly clipboard: Pick<Clipboard, 'writeText'>;
  readonly parent: () => BrowserWindow | null;
  readonly openSource: (source: AgentSource) => void;
  readonly acceptHandlers?: Pick<ProposalAcceptHandlers, 'learning' | 'card' | 'verifyAccepted'>;
  readonly sourceHealthy: (documentId: string, documentHash: string) => Promise<boolean>;
  readonly onAccepted?: (source: { readonly documentId: string; readonly documentHash: string }) => void;
};

/** Native, main-owned controls; neither token nor arbitrary callbacks cross IPC. */
export class AgentAccessController {
  private readonly lifetime = new AgentAccessLifetime();
  private proposalsEnabled = false;
  private proposalGeneration = 0;
  private reviewing = false;
  private changingPermission = false;
  private readonly proposals: ProposalRepository;
  private readonly server: McpServer;
  private readonly reader: LibraryReader;
  constructor(private readonly deps: Dependencies) {
    this.proposals = new ProposalRepository(deps.database, { ...deps.acceptHandlers, annotation: (input) => deps.annotations.create({
      documentId: input.source.documentId, type: 'note', anchor: input.source.anchor,
      selectedText: input.source.anchor.quote.exact, note: input.text, isLocationNote: false,
    }).id });
    this.reader = new LibraryReader(deps.database, deps.search, deps.annotations, deps.positions);
    this.server = new McpServer(new McpTools(this.reader, this.proposals, () => this.proposalsEnabled, () => this.proposalGeneration, deps.sourceHealthy, () => this.lifetime.isOpen()), this.lifetime);
  }
  resolvePassage(reference: PassageReference | AgentSource) {
    if (!this.lifetime.isOpen()) throw new InterleafError('validation', 'Agent access is closed.');
    if ('anchor' in reference) {
      this.proposals.validateSource(reference);
      return { documentId: reference.documentId, documentHash: reference.documentHash, anchor: reference.anchor };
    }
    return this.reader.resolvePassage(reference);
  }
  async start(): Promise<void> {
    try { await this.server.start(); } catch { /* The reader remains available if the local listener cannot start. */ }
  }
  liveWork(): number { return this.lifetime.liveWork(); }
  closeAdmission(): void { this.server.closeAdmission(); }
  async close(): Promise<void> {
    this.closeAdmission();
    await Promise.all([this.server.close(), this.lifetime.drain()]);
  }

  private async admitted(work: () => Promise<void>): Promise<void> {
    const release = this.lifetime.enter();
    if (!release) return;
    try { await work(); } finally { release(); }
  }

  private async show(options: MessageBoxOptions): Promise<number> {
    const parent = this.deps.parent();
    if (!this.lifetime.isOpen()) return 0;
    const withSignal = { ...options, signal: this.lifetime.signal };
    const pending = parent ? this.deps.dialog.showMessageBox(parent, withSignal) : this.deps.dialog.showMessageBox(withSignal);
    this.lifetime.trackDialog(pending);
    const result = await awaitDialog(pending, this.lifetime.signal);
    return this.lifetime.isOpen() ? (result?.response ?? 0) : 0;
  }
  copyConnection(): Promise<void> { return this.admitted(() => this.copyConnectionAdmitted()); }
  private async copyConnectionAdmitted(): Promise<void> {
    const accepted = await this.show({ type: 'question', title: 'Connect an agent', message: 'Copy local MCP connection details?',
      detail: 'Anyone with these details can read your library while Interleaf is open. Share them only with an agent you trust. The access token changes when Interleaf restarts.',
      buttons: ['Cancel', 'Copy details'], defaultId: 0, cancelId: 0 });
    if (accepted !== 1 || !this.lifetime.isOpen()) return;
    let connection: ReturnType<McpServer['connection']>;
    try { connection = this.server.connection(); } catch {
      await this.show({ type: 'warning', title: 'Agent access unavailable', message: 'The local agent service could not start. Restart Interleaf to try again.' });
      return;
    }
    await this.deps.clipboard.writeText(JSON.stringify({ url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } }, null, 2));
  }
  toggleProposals(): Promise<void> { return this.admitted(() => this.toggleProposalsAdmitted()); }
  private async toggleProposalsAdmitted(): Promise<void> {
    if (this.changingPermission) return;
    this.changingPermission = true;
    try { await this.changePermission(); } finally { this.changingPermission = false; }
  }
  private async changePermission(): Promise<void> {
    if (this.proposalsEnabled) {
      this.proposalsEnabled = false;
      this.proposalGeneration += 1;
      await this.show({ type: 'info', title: 'Suggestions disabled', message: 'Connected agents can no longer submit suggestions.' });
      return;
    }
    const accepted = await this.show({ type: 'question', title: 'Allow suggestions', message: 'Allow connected agents to submit suggestions?',
      detail: 'Suggestions stay pending until you review them. Agents cannot accept them or edit documents. This permission lasts until Interleaf closes.',
      buttons: ['Cancel', 'Allow suggestions'], defaultId: 0, cancelId: 0 });
    if (this.lifetime.isOpen() && accepted === 1) { this.proposalsEnabled = true; this.proposalGeneration += 1; }
  }
  review(): Promise<void> { return this.admitted(() => this.reviewAdmitted()); }
  private async reviewAdmitted(): Promise<void> {
    if (this.reviewing) return;
    this.reviewing = true;
    try {
      await reviewProposals({ proposals: this.proposals, show: (options) => this.show(options), isOpen: () => this.lifetime.isOpen(),
        sourceHealthy: this.deps.sourceHealthy, openSource: this.deps.openSource, onAccepted: this.deps.onAccepted });
    } finally { this.reviewing = false; }
  }
}
