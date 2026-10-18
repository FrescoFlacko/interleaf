type QueueEntry<T> =
  | { readonly kind: 'item'; readonly value: T; readonly isPriority: boolean }
  | { readonly kind: 'gap'; count: number };

type QueueDiagnosticEntry<T> =
  | { readonly kind: 'item'; readonly value: T; readonly isPriority: boolean }
  | { readonly kind: 'gap'; readonly count: number };

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly maxSize: number;
  private readonly droppedSummary: (count: number) => T;
  private readonly isPriority: (value: T) => boolean;

  constructor(
    maxSize: number,
    droppedSummary: (count: number) => T,
    isPriority: (value: T) => boolean,
  ) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(1, Math.trunc(maxSize)) : 256;
    this.droppedSummary = droppedSummary;
    this.isPriority = isPriority;
  }

  private readonly entries: QueueEntry<T>[] = [];
  private itemCount = 0;
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  get diagnosticEntryCount(): number { return this.entries.length; }
  get diagnosticItemCount(): number { return this.itemCount; }
  /** A detached snapshot for bounded diagnostics; mutating it cannot alter queue accounting. */
  get diagnosticEntries(): readonly QueueDiagnosticEntry<T>[] {
    return Object.freeze(this.entries.map((entry): QueueDiagnosticEntry<T> => entry.kind === 'gap'
      ? { kind: 'gap', count: entry.count }
      : { kind: 'item', value: entry.value, isPriority: entry.isPriority }));
  }

  push(value: T): void {
    if (this.closed) return;

    if (this.waiters.length > 0 && this.entries.length === 0) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value });
        return;
      }
    }

    const priority = this.isPriority(value);
    if (this.itemCount >= this.maxSize) {
      const nonPriorityIndex = this.findOldestNonPriorityIndex();
      if (nonPriorityIndex >= 0) {
        this.evictAt(nonPriorityIndex);
      } else if (!priority) {
        // Queue is full of priority items; drop incoming normal item and record gap at end
        this.recordDroppedTail();
        return;
      } else {
        // Queue is full of priority items and incoming is priority; evict oldest priority item
        const oldestPriorityIndex = this.findOldestItemIndex();
        if (oldestPriorityIndex >= 0) {
          this.evictAt(oldestPriorityIndex);
        }
      }
    }

    this.entries.push({ kind: 'item', value, isPriority: priority });
    this.itemCount += 1;
    this.notifyWaiter();
  }

  private findOldestNonPriorityIndex(): number {
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry?.kind === 'item' && !entry.isPriority) return i;
    }
    return -1;
  }

  private findOldestItemIndex(): number {
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry?.kind === 'item') return i;
    }
    return -1;
  }

  private recordDroppedTail(): void {
    const last = this.entries[this.entries.length - 1];
    if (last?.kind === 'gap') {
      last.count += 1;
    } else {
      this.entries.push({ kind: 'gap', count: 1 });
    }
  }

  private evictAt(index: number): void {
    if (index < 0 || index >= this.entries.length) return;
    const [evicted] = this.entries.splice(index, 1);
    if (evicted?.kind === 'item') {
      this.itemCount -= 1;
    }

    const prev = this.entries[index - 1];
    const curr = this.entries[index];

    if (prev?.kind === 'gap') {
      prev.count += 1;
      if (curr?.kind === 'gap') {
        prev.count += curr.count;
        this.entries.splice(index, 1);
      }
    } else if (curr?.kind === 'gap') {
      curr.count += 1;
    } else {
      this.entries.splice(index, 0, { kind: 'gap', count: 1 });
    }
  }

  private notifyWaiter(): void {
    if (this.waiters.length > 0 && this.entries.length > 0) {
      const nextItem = this.shiftNext();
      if (nextItem !== undefined) {
        const waiter = this.waiters.shift();
        waiter?.({ done: false, value: nextItem });
      }
    }
  }

  private shiftNext(): T | undefined {
    while (this.entries.length > 0) {
      const entry = this.entries.shift();
      if (entry === undefined) continue;
      if (entry.kind === 'gap') {
        if (entry.count > 0) {
          return this.droppedSummary(entry.count);
        }
        continue;
      }
      this.itemCount -= 1;
      return entry.value;
    }
    return undefined;
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.shiftNext();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
