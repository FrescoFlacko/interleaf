import { useEffect, useRef, useState } from 'react';
import type { LearningContent, LearningSource } from '@shared/schemas/learning';
import { useLearningStore } from '../../../stores/use-learning-store';
import { useReaderStore } from '../../../stores/use-reader-store';
import { bridge } from '../../../app/api-client';
import { LearningSourceReference } from './LearningSourceReference';
import { Select } from '../../../components/ui/select';
import { navigateLearningSource } from '../learning-source';
import { learningInScope } from '../learning-scope';

const labels = { primer: 'Chapter primer', question: 'Passage question', checkpoint: 'Section checkpoint', conflict: 'Conflict prompt' } as const;
type Kind = keyof typeof labels;
function focusReader(): void {
  document.querySelector<HTMLElement>('[data-reader-focus-target="true"]')?.focus();
}
const kindOptions: readonly { value: Kind; label: string }[] = (Object.keys(labels) as Kind[]).map((value) => ({ value, label: labels[value] }));

export function LearningMargin() {
  const session = useReaderStore((state) => state.session);
  const pageCount = useReaderStore((state) => state.pageCount);
  const currentLocation = useReaderStore((state) => state.currentLocation);
  const openDocument = useReaderStore((state) => state.openDocument);
  const { items, primary, secondary, error, load, create, dismiss, remove, clearDraft,
    pending, setPending, message, setMessage, kind, setKind, title, setTitle, body, setBody } = useLearningStore();
  const titleRef = useRef<HTMLInputElement>(null);
  const [showAll, setShowAll] = useState(false);
  const documentId = session?.document.id ?? null;
  useEffect(() => { if (documentId) void load(documentId); }, [documentId, load]);
  useEffect(() => { if (primary) titleRef.current?.focus(); }, [primary]);
  useEffect(() => {
    if (!pending || !session || pageCount <= 0 || pending.documentId !== session.document.id) return;
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      if (pending.documentHash !== session.document.fileHash) {
        if (!cancelled) { setMessage('This source has changed; its passage cannot be opened.'); setPending(null); }
        return;
      }
      try {
        const found = await navigateLearningSource(session.adapter, pending);
        if (!cancelled) {
          setMessage(found ? 'Source opened.' : 'This passage could not be resolved.');
          setPending(null);
          if (found) focusReader();
        }
      } catch {
        if (!cancelled) { setMessage('This passage could not be resolved.'); setPending(null); }
      }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [pending, session, pageCount, setMessage, setPending]);
  const follow = (source: LearningSource): void => {
    if (!documentId) return;
    setMessage('');
    void (async () => {
      try {
        const status = await bridge.learning.sourceStatus(documentId, source);
        if (status.status !== 'current') {
          setMessage(status.status === 'missing' ? 'The source document is unavailable.' : 'The source document has changed.');
          return;
        }
        setPending(source);
        if (source.documentId !== documentId) {
          await openDocument(source.documentId);
          if (useReaderStore.getState().session?.document.id !== source.documentId) {
            setPending(null);
            await openDocument(documentId);
            setMessage('The source document is unavailable.');
          }
        }
      } catch { setMessage('The source document is unavailable.'); }
    })();
  };
  if ((!session || items.length === 0) && !primary && !pending && !message) return null;
  const submit = async (): Promise<void> => {
    if (!primary) return;
    const content: LearningContent = kind === 'conflict'
      ? { kind, title, body, primary, secondary: secondary ?? primary }
      : { kind, title, body, primary };
    if (kind === 'conflict' && !secondary) { setMessage('Select a second passage first.'); return; }
    if (await create(content)) {
      setTitle(''); setBody(''); setMessage('Learning item saved.');
      if (documentId) await load(documentId);
    }
  };
  return (
    <aside aria-label="Learning margin" data-testid="learning-margin" className="w-64 shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-surface p-3 text-xs text-text-primary">
      <h2 className="font-semibold">Learning</h2>
      {primary && <section aria-label="New learning item" className="mt-3 space-y-2">
        <p>Source: “{primary.anchor.quote.exact}”</p>
        <Select aria-label="Kind" value={kind} onValueChange={setKind} options={kindOptions} size="sm" />
        {kind === 'conflict' && <p>{secondary ? `Second source: “${secondary.anchor.quote.exact}”` : 'Select another passage and choose Learning to add a second source.'}</p>}
        <label className="block">Title <input ref={titleRef} value={title} maxLength={200} onChange={(event) => { setTitle(event.target.value); }} className="block w-full border border-border-subtle bg-bg-primary p-1" /></label>
        <label className="block">Text <textarea value={body} maxLength={12000} onChange={(event) => { setBody(event.target.value); }} className="block w-full border border-border-subtle bg-bg-primary p-1" /></label>
        <button type="button" onClick={() => { void submit(); }} disabled={!title.trim() || !body.trim()} className="rounded border border-border-subtle px-2 py-1">Save</button>{' '}
        <button type="button" onClick={() => { clearDraft(); focusReader(); }} className="rounded border border-border-subtle px-2 py-1">Cancel</button>
      </section>}
      {message && <p role="status" className="mt-2">{message}</p>}
      {error && <p role="alert" className="mt-2">{error}</p>}
      {items.length > 0 && <button type="button" aria-pressed={showAll} onClick={() => { setShowAll(!showAll); }} className="mt-2 underline">{showAll ? 'Show nearby' : 'Show all learning'}</button>}
      <ol className="mt-3 space-y-3">
        {items.filter((item) => showAll || item.content.primary.documentHash !== session?.document.fileHash || learningInScope(item.content.primary.anchor, session.adapter.getAnnotationScope(), currentLocation)).map((item) => <li key={item.id} className="rounded border border-border-subtle p-2">
          <p className="font-medium">{labels[item.content.kind]}{item.status === 'dismissed' ? ' · Dismissed' : ''}</p>
          <h3 className="mt-1 font-semibold">{item.content.title}</h3>
          <p className="mt-1 whitespace-pre-wrap">{item.content.body}</p>
          <LearningSourceReference ownerId={item.content.primary.documentId} source={item.content.primary} label="Open source" onFollow={follow} />
          {item.content.kind === 'conflict' && <LearningSourceReference ownerId={item.content.primary.documentId} source={item.content.secondary} label="Open other source" onFollow={follow} />}
          <div className="mt-2 flex gap-2">
            {item.status === 'active' && <button type="button" onClick={() => { focusReader(); void dismiss(item.content.primary.documentId, item.id); }} className="underline">Dismiss</button>}
            <button type="button" onClick={() => { focusReader(); void remove(item.content.primary.documentId, item.id); }} className="underline">Remove</button>
          </div>
        </li>)}
      </ol>
    </aside>
  );
}
