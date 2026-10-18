/**
 * Where one chat controller stands. `loading-document` carries the load in
 * flight so a second request for the same document joins it instead of issuing
 * the reads again; `disposed` is terminal.
 */
type LifecyclePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading-document'; readonly key: string; readonly load: Promise<void> }
  | { readonly kind: 'ready' }
  | { readonly kind: 'disposed' };

/**
 * The document and conversation navigation of one chat controller.
 *
 * The two sequence numbers say which document load and which conversation
 * selection a continuation was started for: anything that resolves after a
 * newer one began belongs to nobody and must not write.
 */
export class ChatLifecycle {
  #phase: LifecyclePhase = { kind: 'idle' };
  #documentSequence = 0;
  #sessionSequence = 0;
  #unsubscribeStream: (() => void) | null = null;

  get isDisposed(): boolean {
    return this.#phase.kind === 'disposed';
  }

  get documentSequence(): number {
    return this.#documentSequence;
  }

  get sessionSequence(): number {
    return this.#sessionSequence;
  }

  /** Starts a new document load (or close), invalidating the previous one. */
  nextDocument(): number {
    this.#documentSequence += 1;
    return this.#documentSequence;
  }

  /** Records a new conversation selection, invalidating the previous one. */
  nextSession(): number {
    this.#sessionSequence += 1;
    return this.#sessionSequence;
  }

  isCurrentDocument(documentSeq: number): boolean {
    return documentSeq === this.#documentSequence;
  }

  isCurrentSession(sessionSeq: number): boolean {
    return sessionSeq === this.#sessionSequence;
  }

  /** The load already in flight for this document key, if any. */
  inFlightLoad(key: string): Promise<void> | null {
    return this.#phase.kind === 'loading-document' && this.#phase.key === key ? this.#phase.load : null;
  }

  beginLoad(key: string, load: Promise<void>): void {
    if (this.isDisposed) return;
    this.#phase = { kind: 'loading-document', key, load };
  }

  /** Marks the load finished, unless a newer load or close has replaced it. */
  finishLoad(key: string): void {
    if (this.#phase.kind === 'loading-document' && this.#phase.key === key) this.#phase = { kind: 'ready' };
  }

  closeDocument(): void {
    if (this.isDisposed) return;
    this.#phase = { kind: 'idle' };
  }

  /** Subscribes to the chat stream once, for as long as the controller lives. */
  ensureSubscribed(subscribe: () => () => void): void {
    if (this.isDisposed) return;
    this.#unsubscribeStream ??= subscribe();
  }

  /**
   * Ends the controller: the stream is unsubscribed and both sequences move, so
   * every continuation still in flight finds it no longer owns anything.
   */
  dispose(): void {
    this.#phase = { kind: 'disposed' };
    this.#unsubscribeStream?.();
    this.#unsubscribeStream = null;
    this.#documentSequence += 1;
    this.#sessionSequence += 1;
  }
}
