import type { ChatCitation } from '@shared/types/ai';
import { MarkdownContent } from '../../components/markdown/MarkdownContent';

type MarkdownMessageProps = {
  readonly content: string;
  readonly citations: ReadonlyMap<string, ChatCitation>;
  readonly onCitation: (sourceId: string) => Promise<void>;
  /** The answer is still streaming, so its citation envelope has not arrived. */
  readonly streaming?: boolean;
};

/** Wording of the inert image placeholder in chat, unchanged by the extraction. */
const CHAT_IMAGE_TITLE = 'Embedded images are not displayed in chat';

/**
 * Chat wrapper over the shared safe Markdown renderer. Chat is the only surface
 * with a citation envelope, so it is the only one that binds citations, and it
 * supplies its own chat-specific inert-image wording. Mermaid fences are drawn
 * once the answer has finished streaming.
 */
export function MarkdownMessage({ content, citations, onCitation, streaming = false }: MarkdownMessageProps) {
  return (
    <MarkdownContent
      content={content}
      citations={citations}
      onCitation={onCitation}
      pendingCitations={streaming}
      imageTitle={CHAT_IMAGE_TITLE}
      diagrams
      deferDiagrams={streaming}
    />
  );
}
