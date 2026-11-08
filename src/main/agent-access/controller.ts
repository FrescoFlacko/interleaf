import type { BrowserWindow, Clipboard, Dialog, MessageBoxOptions } from 'electron';
import type { InterleafDatabase } from '../db/database';
import type { AnnotationRepository } from '../db/repositories/annotation-repository';
import type { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import type { SearchRepository } from '../db/repositories/search-repository';
import { LibraryReader } from './library-reader';
import { ProposalRepository, type ProposalAcceptHandlers } from './proposal-repository';
import { McpTools } from './mcp-tools';
import { McpServer } from './mcp-server';
import { makePassageLink } from './passage-link';

type Dependencies = {
  readonly database: InterleafDatabase;
  readonly search: SearchRepository;
  readonly annotations: AnnotationRepository;
  readonly positions: ReadingPositionRepository;
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly clipboard: Pick<Clipboard, 'writeText'>;
  readonly parent: () => BrowserWindow | null;
  readonly openSource: (link: string) => void;
  readonly acceptHandlers?: Pick<ProposalAcceptHandlers, 'learning' | 'card'>;
};

/** Native, main-owned controls; neither token nor arbitrary callbacks cross IPC. */
export class AgentAccessController {
  private proposalsEnabled = false;
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
    this.server = new McpServer(new McpTools(this.reader, this.proposals, () => this.proposalsEnabled));
  }
  resolvePassage(reference: { readonly documentId: string; readonly documentHash: string; readonly chunkId: string }) {
    const passage = this.reader.getPassage(reference);
    return { documentId: passage.documentId, documentHash: passage.documentHash, location: passage.location };
  }
  async start(): Promise<void> {
    try { await this.server.start(); } catch { /* The reader remains available if the local listener cannot start. */ }
  }
  close(): Promise<void> { return this.server.close(); }

  private async show(options: MessageBoxOptions): Promise<number> {
    const parent = this.deps.parent();
    const result = parent ? await this.deps.dialog.showMessageBox(parent, options) : await this.deps.dialog.showMessageBox(options);
    return result.response;
  }
  async copyConnection(): Promise<void> {
    const accepted = await this.show({ type: 'question', title: 'Connect an agent', message: 'Copy local MCP connection details?',
      detail: 'Anyone with these details can read your library while Interleaf is open. Share them only with an agent you trust. The access token changes when Interleaf restarts.',
      buttons: ['Cancel', 'Copy details'], defaultId: 0, cancelId: 0 });
    if (accepted !== 1) return;
    let connection: ReturnType<McpServer['connection']>;
    try { connection = this.server.connection(); } catch {
      await this.show({ type: 'warning', title: 'Agent access unavailable', message: 'The local agent service could not start. Restart Interleaf to try again.' });
      return;
    }
    await this.deps.clipboard.writeText(JSON.stringify({ url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } }, null, 2));
  }
  async toggleProposals(): Promise<void> {
    if (this.changingPermission) return;
    this.changingPermission = true;
    try { await this.changePermission(); } finally { this.changingPermission = false; }
  }
  private async changePermission(): Promise<void> {
    if (this.proposalsEnabled) {
      this.proposalsEnabled = false;
      await this.show({ type: 'info', title: 'Suggestions disabled', message: 'Connected agents can no longer submit suggestions.' });
      return;
    }
    const accepted = await this.show({ type: 'question', title: 'Allow suggestions', message: 'Allow connected agents to submit suggestions?',
      detail: 'Suggestions stay pending until you review them. Agents cannot accept them or edit documents. This permission lasts until Interleaf closes.',
      buttons: ['Cancel', 'Allow suggestions'], defaultId: 0, cancelId: 0 });
    this.proposalsEnabled = accepted === 1;
  }
  async review(): Promise<void> {
    if (this.reviewing) return;
    this.reviewing = true;
    try { await this.reviewPending(); } finally { this.reviewing = false; }
  }
  private async reviewPending(): Promise<void> {
    const pending = this.proposals.list();
    if (pending.length === 0) { await this.show({ type: 'info', title: 'Suggestions', message: 'No pending suggestions.' }); return; }
    for (const proposal of pending) {
      const input = proposal.input;
      const canAccept = this.proposals.canAccept(input.kind);
      const buttons = ['Later', 'Open source', ...(input.kind === 'conflict' ? ['Open second source'] : []), 'Reject', ...(canAccept ? ['Accept'] : [])];
      const choice = await this.show({ type: 'question', title: 'Review suggestion',
        message: `${input.kind}: ${input.text}`, detail: `Source quote: ${input.source.anchor.quote.exact}\nDocument: ${this.proposals.sourceTitle(input.source.documentId)}${input.kind === 'conflict' ? `\nSecond source: ${input.secondSource.anchor.quote.exact}\nDocument: ${this.proposals.sourceTitle(input.secondSource.documentId)}` : ''}${canAccept ? '' : '\nAcceptance is not available yet.'}`,
        buttons, defaultId: 0, cancelId: 0 });
      if (choice === 0) return;
      if (choice === 1 || (input.kind === 'conflict' && choice === 2)) {
        const source = input.kind === 'conflict' && choice === 2 ? input.secondSource : input.source;
        this.deps.openSource(makePassageLink(source));
        return;
      }
      const rejectChoice = input.kind === 'conflict' ? 3 : 2;
      try { this.proposals.resolve(proposal.id, choice === rejectChoice ? 'reject' : 'accept'); }
      catch { await this.show({ type: 'warning', title: 'Suggestion not accepted', message: 'The source changed or this suggestion type is not available yet. It remains pending.' }); }
    }
  }
}
