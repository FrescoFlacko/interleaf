import { practiceSourceLocation } from './source-label';
import { Select } from '../../components/ui/select';
import { useEffect, useState } from 'react';
import type { PracticeCard, PracticeRating } from '@shared/schemas/practice';
import type { AIProviderStatus } from '@shared/types/ai';
import { bridge } from '../../app/api-client';
import { useReaderStore } from '../../stores/use-reader-store';
import { usePracticeNavigationStore } from './use-practice-navigation';

export function PracticeReview({ onClose }: { readonly onClose: () => void }) {
  const [cards, setCards] = useState<readonly PracticeCard[]>([]);
  const [answer, setAnswer] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState('Loading due cards…');
  const [choices, setChoices] = useState<readonly AIProviderStatus[]>([]);
  const [selection, setSelection] = useState('');
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showExport, setShowExport] = useState(false);
  const card = cards[0];
  useEffect(() => {
    let live = true;
    void bridge.practice.due(20).then((items) => { if (live) { setCards(items); setStatus(items.length ? '' : 'No cards are due.'); } }).catch(() => { if (live) setStatus('Could not load practice cards.'); });
    return () => { live = false; void bridge.practice.cancelCheck(); };
  }, []);
  const loadChoices = () => {
    void bridge.ai.listProviders().then((items) => {
      const eligible = items.filter((p) => ['claude', 'pi', 'omp'].includes(p.id) && p.available && p.authentication === 'connected' && p.capabilities.toolFreeMode && p.models.length > 0);
      setChoices(eligible); if (!eligible.length) setFeedback('Checking is unavailable. Compare your answer with the source below.');
    }).catch(() => { setFeedback('Checking is unavailable. Compare your answer with the source below.'); });
  };
  const rate = (rating: PracticeRating) => {
    if (!card) return;
    void bridge.practice.rate({ cardId: card.id, revision: card.revision, rating }).then(() => {
      setCards((items) => items.slice(1)); setAnswer(''); setRevealed(false); setFeedback(''); setChoices([]); setSelection(''); setShowExport(false);
      if (cards.length === 1) setStatus('Review complete.');
    }).catch(() => { setStatus('The card changed or could not be saved. Reopen review.'); });
  };
  const openSource = () => {
    if (!card) return;
    void bridge.practice.get(card.id).then(async (current) => {
      if (current?.sourceState !== 'available' || current.navigation === null) { setStatus('The source is unavailable or has changed.'); return; }
      usePracticeNavigationStore.getState().setPending({ source: current.navigation });
      await useReaderStore.getState().openDocument(current.navigation.documentId, null, current.navigation.documentHash);
      if (!useReaderStore.getState().session) {
        usePracticeNavigationStore.getState().setPending(null);
        setStatus('The source could not be opened. It may be missing or changed.');
      }
    }).catch(() => { setStatus('The source could not be opened.'); });
  };
  return <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-6" data-testid="practice-review">
    <div className="flex items-center gap-4"><h1 className="text-xl font-semibold">Review practice</h1><button type="button" className="underline" onClick={onClose}>Back to library</button></div>
    {status && <p role="status">{status}</p>}
    {card && <div className="flex max-w-2xl flex-col gap-4">
      <p>{cards.length} in this queue · {card.sourceLabel}{card.navigation && ` · ${practiceSourceLocation(card.navigation.anchor)}`}</p><h2 className="text-lg">{card.question}</h2>
      <label> Your answer<textarea className="block w-full rounded border border-border-subtle p-2" value={answer} maxLength={4000} onChange={(event) => { setAnswer(event.target.value); }} /></label>
      {!revealed && <button type="button" className="self-start underline" disabled={!answer.trim()} onClick={() => { setRevealed(true); }}>Reveal source</button>}
      {revealed && <>
        <p>Compare your answer with the {card.source.kind === 'imported' ? 'exported highlight (not a verified book passage)' : 'saved highlight'} below. Automated feedback may be wrong; you choose the rating.</p>
        <blockquote className="rounded border border-border-subtle p-3 whitespace-pre-wrap">{card.evidence}</blockquote>
        <p>Source status: {card.sourceState}</p>
        {card.source.kind === 'imported' && card.sourceState !== 'missing' && <button type="button" className="self-start underline" onClick={() => { setShowExport(!showExport); }}>View exported highlight</button>}
        {showExport && <div role="region" aria-label="Exported highlight record"><p>{card.sourceLabel}</p>{card.exportDetails?.location && <p>Location: {card.exportDetails.location}</p>}{card.exportDetails?.date && <p>Date: {card.exportDetails.date}</p>}{card.exportDetails?.note && <p>Note: {card.exportDetails.note}</p>}<blockquote className="whitespace-pre-wrap">{card.evidence}</blockquote><p>From your export; this quote is not independently verified against the book.</p></div>}
        <button type="button" className="self-start underline" onClick={openSource} disabled={card.sourceState !== 'available'}>Open source passage</button>
        <button type="button" className="self-start underline" onClick={loadChoices} disabled={!answer.trim() || checking}>Choose a provider for an optional check</button>
        {choices.length > 0 && <><label>Provider and model <Select aria-label="Provider and model" value={selection} onValueChange={setSelection} options={[{ value: "", label: "Choose…" }, ...choices.flatMap((p) => p.models.map((m) => ({ value: JSON.stringify([p.id, m.id]), label: `${p.name} · ${m.name}` })))]} /></label>
          <p>The question, answer and displayed evidence will be sent to the selected provider; provider usage may be charged.</p>
          <button type="button" className="self-start underline" disabled={!selection || checking} onClick={() => {
            const selected = choices.flatMap((p) => p.models.map((m) => ({ value: JSON.stringify([p.id, m.id]), providerId: p.id, modelId: m.id }))).find((item) => item.value === selection);
            if (!selected) return;
            setChecking(true); setFeedback('Checking…');
            void bridge.practice.check({ cardId: card.id, answer, providerId: selected.providerId, modelId: selected.modelId }).then((text) => { setFeedback(text ?? 'Checking is unavailable. Compare manually with the source.'); }).catch(() => { setFeedback('Checking is unavailable. Compare manually with the source.'); }).finally(() => { setChecking(false); });
          }}>Send for source check</button></>}
        {checking && <button type="button" className="self-start underline" onClick={() => { void bridge.practice.cancelCheck(); }}>Cancel check</button>}
        {feedback && <p role="status" className="whitespace-pre-wrap">{feedback}</p>}
        <p>How well did you recall it?</p><div className="flex flex-wrap gap-4">{(['again', 'hard', 'good', 'easy'] as const).map((rating) => <button type="button" className="rounded border border-border-subtle px-3 py-2 capitalize" key={rating} disabled={checking} onClick={() => { rate(rating); }}>{rating}</button>)}</div>
      </>}
    </div>}
  </section>;
}
