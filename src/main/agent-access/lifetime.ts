/** Owns accepted native and HTTP work through shutdown. */
export class AgentAccessLifetime {
  private readonly aborter = new AbortController();
  private count = 0;
  private pendingDialogs = 0;
  private readonly drained = new Set<() => void>();

  get signal(): AbortSignal { return this.aborter.signal; }
  isOpen(): boolean { return !this.signal.aborted; }
  liveWork(): number { return this.count + (this.isOpen() ? 0 : this.pendingDialogs); }

  trackDialog<T>(promise: Promise<T>): void {
    this.pendingDialogs += 1;
    void promise.then(() => { this.pendingDialogs -= 1; }, () => { this.pendingDialogs -= 1; });
  }

  enter(): (() => void) | null {
    if (!this.isOpen()) return null;
    this.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count -= 1;
      if (this.count === 0) for (const resolve of this.drained) resolve();
    };
  }

  closeAdmission(): void { this.aborter.abort(); }

  async drain(): Promise<void> {
    if (this.count === 0) return;
    await new Promise<void>((resolve) => { this.drained.add(resolve); });
    this.drained.clear();
  }
}

/** Abort releases the caller even when a platform dialog cannot be dismissed. */
export function awaitDialog<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); resolve(null); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(new Error('Native dialog failed.')); });
    if (signal.aborted) abort();
  });
}
