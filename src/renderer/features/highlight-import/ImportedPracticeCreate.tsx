import { useState } from 'react';
import { bridge } from '../../app/api-client';

export function ImportedPracticeCreate({ importedHighlightId }: { readonly importedHighlightId: string }) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState('');
  const [message, setMessage] = useState('');
  if (!editing) return <><button type="button" className="text-xs underline" onClick={() => { setEditing(true); setMessage(''); }}>Make practice card</button>{message && <p role="status">{message}</p>}</>;
  return <form className="flex flex-col gap-2" onSubmit={(event) => {
    event.preventDefault();
    void bridge.practice.createImported({ importedHighlightId, question }).then(() => {
      setEditing(false); setQuestion(''); setMessage('Practice card saved.');
    }).catch(() => { setMessage('The imported highlight is unavailable or the card could not be saved.'); });
  }}>
    <label>Question <input className="w-full rounded border border-border-subtle p-1" value={question} maxLength={2000} required onChange={(event) => { setQuestion(event.target.value); }} /></label>
    <div><button type="submit" className="text-xs underline">Save card</button>{' '}<button type="button" className="text-xs underline" onClick={() => { setEditing(false); }}>Cancel</button></div>
    {message && <p role="status">{message}</p>}
  </form>;
}
