import { useReaderStore } from '../../stores/use-reader-store';
import { usePracticeNavigation } from './use-practice-navigation';

export function PracticeNavigationNotice() {
  const session = useReaderStore((state) => state.session);
  const pageCount = useReaderStore((state) => state.pageCount);
  const error = usePracticeNavigation(session, pageCount);
  return error ? <p role={error === 'Source passage opened.' ? 'status' : 'alert'} className="p-2 text-sm">{error}</p> : null;
}
