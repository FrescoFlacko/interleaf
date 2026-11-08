import { Select } from '../../components/ui/select';
import { useEffect, useRef, useState } from 'react';
import { bridge } from '../../app/api-client';
import { useReaderStore } from '../../stores/use-reader-store';
import type { DocumentMetadata } from '@shared/types/document';
import type { ImportedHighlight, ImportPreview } from '@shared/types/imported-highlight';

export function ImportedHighlights() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [records, setRecords] = useState<readonly ImportedHighlight[]>([]);
  const [documents, setDocuments] = useState<readonly DocumentMetadata[]>([]);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const session = useRef<{ closed: boolean } | null>(null);
  const openDocument = useReaderStore((state) => state.openDocument);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([bridge.importedHighlights.list(offset), bridge.library.listDocuments({ searchQuery: search, limit: 100 })])
      .then(([items, docs]) => { if (live) { setRecords(items); setDocuments(docs); } })
      .catch(() => { if (live) setMessage('Could not load imported highlights.'); });
    return () => { live = false; };
  }, [open, offset, search]);
  function release(): void {
    epoch.current += 1;
    void bridge.importedHighlights.release().catch(() => undefined);
    setPreview(null);
    setBusy(false);
  }
  function close(): void {
    if (session.current) session.current.closed = true;
    release();
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const active = session.current;
    return () => {
      if (active && !active.closed) {
        active.closed = true;
        epoch.current += 1;
        void bridge.importedHighlights.release().catch(() => undefined);
      }
    };
  }, [open]);
  async function choose(): Promise<void> {
    const request = ++epoch.current;
    setBusy(true); setMessage(''); setPreview(null);
    try {
      const result = await bridge.importedHighlights.preview();
      if (epoch.current === request) { setPreview(result); setChoices({}); }
    } catch (error) {
      if (epoch.current === request) setMessage(error instanceof Error ? error.message : 'Could not read that file.');
    } finally { if (epoch.current === request) setBusy(false); }
  }
  async function commit(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await bridge.importedHighlights.commit({ token: preview.token,
        choices: preview.titles.map(({ key }) => ({ key, documentId: choices[key] === '' ? null : (choices[key] ?? null) })) });
      setMessage(`Imported ${String(result.inserted)}; skipped ${String(result.duplicates)} duplicates.`);
      setPreview(null); setOffset(0); setRecords(await bridge.importedHighlights.list(0));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Import failed.'); setPreview(null); }
    finally { setBusy(false); }
  }
  async function associate(id: string, documentId: string): Promise<void> {
    try {
      await bridge.importedHighlights.associate(id, documentId || null);
      setRecords(await bridge.importedHighlights.list(offset));
    } catch { setMessage('Could not associate that document.'); }
  }
  function documentOptions(current: string | null = null) {
    const options = [{ value: '', label: 'Unmatched' }, ...documents.map((doc) => ({ value: doc.id, label: `${doc.title}${doc.author ? ` — ${doc.author}` : ''}` }))];
    if (current !== null && !documents.some((doc) => doc.id === current)) options.push({ value: current, label: 'Current association' });
    return options;
  }
  return <>
    <button type="button" className="shrink-0 whitespace-nowrap rounded border border-border-subtle px-2 py-1" onClick={() => { if (open) close(); else { session.current = { closed: false }; setOpen(true); } }}>Imported highlights</button>
    {open && <section aria-label="Imported highlights" className="absolute inset-4 z-50 flex flex-col overflow-auto rounded border border-border-subtle bg-bg-primary p-5 shadow-xl">
      <div className="flex justify-between"><h2 className="text-lg font-semibold">Imported highlights</h2><button type="button" onClick={close}>Close</button></div>
      <p className="text-sm">Kindle My Clippings or Readwise Highlights CSV. Source locations are not verified passages.</p>
      <div><button type="button" disabled={busy} onClick={() => { void choose(); }} className="my-2 rounded bg-accent px-3 py-1 text-on-accent">Choose export…</button></div>
      {message && <p role="status">{message}</p>}
      <label>Find library documents <input value={search} onChange={(event) => { setSearch(event.target.value); }} className="border border-border-subtle" /></label>
      {preview && <div className="my-3 border border-border-subtle p-3">
        <h3 className="font-semibold">Preview: {preview.provider === 'kindle' ? 'Kindle' : 'Readwise'}</h3>
        <p>{preview.count} highlights; {preview.duplicates} duplicates. Matches are your confirmation of the book, not its passage.</p>
        {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        {preview.titles.map((group) => <div key={group.key} className="my-2 block">{group.title}{group.author ? ` — ${group.author}` : ''} ({group.count}) <Select aria-label={`Match ${group.title}`} value={choices[group.key] ?? ''} options={documentOptions()} onValueChange={(value) => { setChoices({ ...choices, [group.key]: value }); }} /></div>)}
        <h4>Sample highlights (up to 20)</h4>{preview.samples.map((sample, index) => <p key={index}><strong>{sample.title}</strong>: {sample.quote} {sample.location && `(${sample.location})`}</p>)}
        <button type="button" disabled={busy || preview.count === 0} onClick={() => { void commit(); }} className="rounded bg-accent px-3 py-1 text-on-accent">Confirm import</button>
        <button type="button" onClick={release} className="ml-3">Cancel</button>
      </div>}
      <h3 className="mt-3 font-semibold">Saved highlights</h3>
      {records.map((item) => <article key={item.id} className="my-2 border border-border-subtle p-2">
        <p><strong>{item.title}</strong>{item.author && ` — ${item.author}`} · {item.provider}</p>
        <blockquote>{item.quote}</blockquote>{item.note && <p>Note: {item.note}</p>}{item.location && <p>Source location: {item.location}</p>}
        <div>Confirmed library document <Select aria-label={`Match saved ${item.title}`} value={item.documentId ?? ''} options={documentOptions(item.documentId)} onValueChange={(value) => { void associate(item.id, value); }} /></div>
        {item.documentId && <button type="button" className="ml-2 underline" onClick={() => { void openDocument(item.documentId ?? ''); }}>Open document</button>}
        <p>No verified passage location.</p>
      </article>)}
      <div><button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); }}>Previous</button><button type="button" disabled={records.length < 50} onClick={() => { setOffset(offset + 50); }} className="ml-4">Next</button></div>
    </section>}
  </>;
}
