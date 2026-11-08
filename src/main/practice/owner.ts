import { InterleafError } from '@shared/errors/interleaf-error';
import type { PracticeChecker } from './checker';

type Sender = { readonly id: number; isDestroyed(): boolean; once(event: 'destroyed', listener: () => void): void };
const watched = new WeakSet<Sender>();

/** Keep one cleanup listener per window even after many practice checks. */
export function practiceOwner(sender: Sender | undefined, checker: PracticeChecker): number {
  if (!sender || sender.isDestroyed()) throw new InterleafError('sender-rejected', 'A live window is required.');
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.once('destroyed', () => { checker.cancel(sender.id); });
  }
  return sender.id;
}
