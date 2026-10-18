/**
 * The assistant's name above its turn.
 *
 * One component so an answer and the notice that one is being generated carry
 * the identical label: the transcript never appears to gain a second speaker
 * when generation starts, and renaming the assistant is one edit.
 */
export function ChatAssistantLabel() {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
      <span className="font-mono text-2xs font-medium tracking-[0.1em] text-text-secondary">READER AI</span>
    </div>
  );
}
