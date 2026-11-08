import type { MessageBoxOptions } from 'electron';
import type { AgentProposalInput, AgentSource } from '@shared/schemas/agent-access';
import type { Proposal, ProposalRepository } from './proposal-repository';

type ReviewDependencies = {
  readonly proposals: ProposalRepository;
  readonly show: (options: MessageBoxOptions) => Promise<number>;
  readonly isOpen: () => boolean;
  readonly sourceHealthy: (documentId: string, documentHash: string) => Promise<boolean>;
  readonly openSource: (source: AgentSource) => void;
  readonly onAccepted: ((source: { readonly documentId: string; readonly documentHash: string }) => void) | undefined;
};

async function sourcesHealthy(input: AgentProposalInput, deps: ReviewDependencies): Promise<boolean> {
  const sources = input.kind === 'conflict' ? [input.source, input.secondSource] : [input.source];
  for (const source of sources) {
    if (!(await deps.sourceHealthy(source.documentId, source.documentHash)) || !deps.isOpen()) return false;
  }
  return true;
}

function notifyAccepted(input: AgentProposalInput, deps: ReviewDependencies): void {
  try { deps.onAccepted?.({ documentId: input.source.documentId, documentHash: input.source.documentHash }); }
  catch { /* The transaction succeeded; a closed renderer does not undo it. */ }
}

async function resolveChoice(proposal: Proposal, choice: number, canAccept: boolean, deps: ReviewDependencies): Promise<boolean> {
  const input = proposal.input;
  const rejectChoice = input.kind === 'conflict' ? 3 : 2;
  if (choice !== rejectChoice && (!canAccept || choice !== rejectChoice + 1)) return false;
  try {
    if (choice !== rejectChoice && !(await sourcesHealthy(input, deps))) {
      if (!deps.isOpen()) return false;
      throw new Error('Source is unavailable.');
    }
    if (!deps.isOpen()) return false;
    const result = deps.proposals.resolve(proposal.id, choice === rejectChoice ? 'reject' : 'accept');
    if (result.status === 'accepted') notifyAccepted(input, deps);
  } catch {
    await deps.show({ type: 'warning', title: 'Suggestion not accepted', message: 'The source changed or this suggestion type is not available yet. It remains pending.' });
  }
  return true;
}

async function reviewOne(proposal: Proposal, deps: ReviewDependencies): Promise<boolean> {
  const input = proposal.input;
  const canAccept = deps.proposals.canAccept(input.kind);
  const buttons = ['Later', 'Open source', ...(input.kind === 'conflict' ? ['Open second source'] : []), 'Reject', ...(canAccept ? ['Accept'] : [])];
  const choice = await deps.show({ type: 'question', title: 'Review suggestion',
    message: `${input.kind}: ${input.text}`, detail: `Source quote: ${input.source.anchor.quote.exact}\nDocument: ${deps.proposals.sourceTitle(input.source.documentId)}${input.kind === 'conflict' ? `\nSecond source: ${input.secondSource.anchor.quote.exact}\nDocument: ${deps.proposals.sourceTitle(input.secondSource.documentId)}` : ''}${canAccept ? '' : '\nAcceptance is not available yet.'}`,
    buttons, defaultId: 0, cancelId: 0 });
  if (choice === 0 || !deps.isOpen()) return false;
  if (choice === 1 || (input.kind === 'conflict' && choice === 2)) {
    deps.openSource(input.kind === 'conflict' && choice === 2 ? input.secondSource : input.source);
    return false;
  }
  return resolveChoice(proposal, choice, canAccept, deps);
}

/** Review stays main-owned and each source check remains inside admitted work. */
export async function reviewProposals(deps: ReviewDependencies): Promise<void> {
  const pending = deps.proposals.list();
  if (pending.length === 0) { await deps.show({ type: 'info', title: 'Suggestions', message: 'No pending suggestions.' }); return; }
  for (const proposal of pending) if (!(await reviewOne(proposal, deps))) return;
}
