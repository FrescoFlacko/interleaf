import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { DocumentMetadata } from '@shared/types/document';
import type { DocumentServices, OpenFileStore, OpenFileStoreDeps } from './open-file-store';
import { WorkAdmission } from '../app/work-admission';

/** How many closed documents keep answering "no longer open" instead of falling through. */
const RETIRED_DOCUMENT_LIMIT = 64;

export type OpenFileManagerDeps = {
  /** Main-owned parent of every store's staging directory. */
  readonly root: string;
  readonly createStore: (deps: Pick<OpenFileStoreDeps, 'root'>) => Promise<OpenFileStore>;
  /** Main's native Open dialog; `null` when the reader cancels. */
  readonly chooseFile: () => Promise<string | null>;
  /** The file the operating system most recently asked the application to open. */
  readonly takePendingPath: () => string | null;
};

/**
 * Owns the files opened without joining the library.
 *
 * At most one is open. Opening another replaces it only once the new file has
 * loaded, so a refused file leaves the current one readable. Every lifecycle
 * step is serialized, and a document that has been closed keeps being refused
 * by id, so late work can never fall through to the library's stores.
 */
export class OpenFileManager {
  private readonly deps: OpenFileManagerDeps;
  private current: OpenFileStore | null = null;
  private readonly retired = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Opens queued or loading, counted from the moment they are requested. */
  private readonly opens = new WorkAdmission();

  constructor(deps: OpenFileManagerDeps) {
    this.deps = deps;
  }

  /** Removes whatever a previous process left staged before it could clean up. */
  static async discardLeftovers(root: string): Promise<void> {
    const entries = await readdir(root);
    await Promise.all(entries.map((entry) => rm(join(root, entry), { recursive: true, force: true })));
  }

  chooseFile(): Promise<string | null> {
    return this.deps.chooseFile();
  }

  takePendingPath(): string | null {
    return this.deps.takePendingPath();
  }

  open(filePath: string): Promise<DocumentMetadata> {
    return this.opens.run(() => this.serialize(async () => {
      if (this.stopped) throw new InterleafError('internal', 'Application is shutting down.');
      const store = await this.deps.createStore({ root: join(this.deps.root, randomUUID()) });
      let document: DocumentMetadata;
      try {
        document = await store.load(filePath);
      } catch (error) {
        await store.dispose();
        throw error;
      }
      await this.retireCurrent();
      this.makeCurrent(store);
      return document;
    }));
  }

  /** Closes the open file when it is `documentId`; any other id is a no-op. */
  close(documentId: string): Promise<void> {
    return this.serialize(() => this.current?.documentId === documentId ? this.retireCurrent() : Promise.resolve());
  }

  closeAll(): Promise<void> {
    return this.serialize(() => this.retireCurrent());
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    return this.closeAll();
  }

  /** Opens queued or loading; each imports its file into a private store. */
  liveOpens(): number {
    return this.opens.liveWork();
  }

  /** The open file's chat responses, preparations and compactions. */
  liveChatWork(): number {
    return this.current?.services.chat.liveWork() ?? 0;
  }

  /**
   * Refuses new opens and new chat work in the open file, while reads, closes
   * and cancellation keep working. An open admitted earlier still loads, so
   * its own chat is closed as it becomes current.
   */
  closeAdmission(): void {
    this.opens.close();
    this.current?.services.chat.closeAdmission();
  }

  /** True for the open file and for any file closed during this run. */
  owns(documentId: string): boolean {
    return this.current?.documentId === documentId || this.retired.has(documentId);
  }

  /**
   * The services that own `documentId`, or `null` when it belongs to the
   * library. A closed file's id is refused rather than answered by the library.
   */
  forDocument(documentId: string): DocumentServices | null {
    if (this.current?.documentId === documentId) return this.current.services;
    if (this.retired.has(documentId)) {
      throw new InterleafError('media-not-found', 'This document is no longer open.');
    }
    return null;
  }

  forSession(sessionId: string): DocumentServices | null {
    return this.current?.ownsSession(sessionId) === true ? this.current.services : null;
  }

  /** Cancellation carries only a request id, so it is offered to the open file too. */
  cancel(requestId: string, ownerId: number): Promise<void> {
    return this.current?.services.chat.cancel(requestId, ownerId) ?? Promise.resolve();
  }

  /** An open admitted before admission closed still loads, but its chat starts closed. */
  private makeCurrent(store: OpenFileStore): void {
    if (this.opens.isClosed()) store.services.chat.closeAdmission();
    this.current = store;
  }

  private async retireCurrent(): Promise<void> {
    const store = this.current;
    if (store === null) return;
    this.current = null;
    const documentId = store.documentId;
    if (documentId !== null) this.retire(documentId);
    await store.dispose();
  }

  private retire(documentId: string): void {
    this.retired.add(documentId);
    if (this.retired.size > RETIRED_DOCUMENT_LIMIT) {
      const oldest = this.retired.values().next().value;
      if (oldest !== undefined) this.retired.delete(oldest);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
