import { LibraryView } from '../library/LibraryView';
import { PracticeReview } from './PracticeReview';
import { usePracticeView } from './practice-view-store';
export function PracticeLibrary() {
  const open = usePracticeView((state) => state.open);
  const setOpen = usePracticeView((state) => state.setOpen);
  return open ? <PracticeReview onClose={() => { setOpen(false); }} /> : <LibraryView />;
}
