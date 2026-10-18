import type { ChatContextItem } from '@shared/types/ai';
import { chatStarters } from './chat-follow-ups';

export type ChatStarterPromptsProps = {
  /** Title of the open document; used inside the starter prompts, not displayed. */
  readonly documentTitle: string;
  readonly contextItems: readonly ChatContextItem[];
  /** Starters are offered only while the composer can take the draft. */
  readonly startersAvailable: boolean;
  /** Places a starter in the composer. It never sends. */
  readonly onStarter: (prompt: string) => void;
};

/**
 * The scaffolding under the empty thread's heading: what a grounded answer is,
 * and starter prompts. The document's name is already in the reader, so it is
 * not repeated here; the starters still name it in the prompts they fill. A starter fills the composer
 * and focuses it; the reader edits or sends.
 */
export function ChatStarterPrompts({
  documentTitle,
  contextItems,
  startersAvailable,
  onStarter,
}: ChatStarterPromptsProps) {
  const starters = startersAvailable ? chatStarters(documentTitle, contextItems) : [];
  return (
    <>
      <p className="mt-1 max-w-xs text-2xs leading-relaxed">
        Grounded answers cite exact pages and sections. Attach pages or a selection with Add context to focus an answer.
      </p>
      {starters.length > 0 && (
        <div role="group" aria-label="Starter prompts" data-testid="chat-starters" className="chat-design-starters">
          {starters.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="chat-design-starter"
              title={starter.prompt}
              onClick={() => { onStarter(starter.prompt); }}
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
