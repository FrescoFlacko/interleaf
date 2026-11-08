import { usePracticeView } from './practice-view-store';
export function PracticeEntry() {
  const setOpen = usePracticeView((state) => state.setOpen);
  return <button type="button" className="shrink-0 text-xs underline" onClick={() => { setOpen(true); }}>Review practice</button>;
}
