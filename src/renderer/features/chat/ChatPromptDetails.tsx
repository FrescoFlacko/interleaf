import { useId, useState } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { writeClipboardText } from '../../app/api-client';
import type { ChatToastTone } from './use-chat-toast';

export type PromptDetailToken = {
  readonly label: string;
  readonly value: string;
};

type ChatPromptDetailsProps = {
  /** The user turn that produced the answer, or null when none precedes it. */
  readonly prompt: string | null;
  /** Labelled facts the app actually holds about the answer. */
  readonly tokens: readonly PromptDetailToken[];
  /** Whether the composer can take the prompt right now. */
  readonly reuseAvailable: boolean;
  readonly onReuse: (prompt: string) => void;
  readonly onNotice: (tone: ChatToastTone, message: string) => void;
};

/**
 * A collapsed "how this was made" disclosure under an answer (DESIGN.md,
 * Prompt details). It shows the exact request as text and only the parameters
 * the app recorded; it never claims which context a past turn used, because
 * turns do not record that.
 */
export function ChatPromptDetails({ prompt, tokens, reuseAvailable, onReuse, onNotice }: ChatPromptDetailsProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  return (
    <div className="chat-design-prompt-details" data-testid="chat-prompt-details">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => { setExpanded((current) => !current); }}
        className="chat-design-prompt-details-toggle"
      >
        <AppIcon name={expanded ? 'disclosure-expanded' : 'disclosure-collapsed'} size={12} />
        Prompt details
      </button>
      {/* The body mounts only when open, so a collapsed copy of the prompt is
        * never part of the transcript's text. */}
      <div id={regionId} hidden={!expanded} className="chat-design-prompt-details-body">
        {expanded && (
          <PromptDetailsBody prompt={prompt} tokens={tokens} reuseAvailable={reuseAvailable} onReuse={onReuse} onNotice={onNotice} />
        )}
      </div>
    </div>
  );
}

function PromptDetailsBody({ prompt, tokens, reuseAvailable, onReuse, onNotice }: ChatPromptDetailsProps) {
  const copy = async (text: string): Promise<void> => {
    try {
      await writeClipboardText(text);
      onNotice('success', 'Prompt copied');
    } catch {
      onNotice('error', 'Could not copy prompt');
    }
  };

  return (
    <>
      <p className="chat-design-prompt-details-label">Prompt</p>
      {prompt === null ? (
        <p className="text-2xs text-text-secondary">This conversation holds no request for this answer.</p>
      ) : (
        <p data-testid="chat-prompt-details-text" className="chat-design-prompt-details-text">{prompt}</p>
      )}
      {tokens.length > 0 && (
        <dl aria-label="Answer parameters" className="chat-design-param-tokens">
          {tokens.map((token) => (
            <div key={token.label} className="chat-design-param-token">
              <dt>{token.label}</dt>
              <dd>{token.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-2xs leading-snug text-text-secondary">
        Provider and model are this conversation’s binding. Which context a past turn used is not recorded.
      </p>
      {prompt !== null && (
        <div className="chat-design-prompt-details-actions">
          <button type="button" onClick={() => { void copy(prompt); }}>Copy prompt</button>
          <button type="button" disabled={!reuseAvailable} onClick={() => { onReuse(prompt); }}>Reuse prompt</button>
        </div>
      )}
    </>
  );
}
