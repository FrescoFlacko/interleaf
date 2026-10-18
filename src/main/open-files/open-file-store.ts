import { mkdir, rm } from 'node:fs/promises';
import { InterleafDatabase } from '../db/database';
import { runMigrations } from '../db/migrations';
import { DocumentRepository } from '../db/repositories/document-repository';
import { DocumentAssetRepository } from '../db/repositories/document-asset-repository';
import { FolderRepository } from '../db/repositories/folder-repository';
import { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import { AnnotationRepository } from '../db/repositories/annotation-repository';
import { SearchRepository } from '../db/repositories/search-repository';
import { ChatRepository } from '../db/repositories/chat-repository';
import { ChatTitleRepository } from '../db/repositories/chat-title-repository';
import { AIContextRepository } from '../ai/context-repository';
import { ChatService, type ChatProviderGateway } from '../ai/chat-service';
import type { ConversationTitler } from '../ai/conversation-titling';
import { StorageManager } from '../library/storage-manager';
import { LibraryService } from '../library/library-service';
import type { AssetRegistry } from '../security/asset-registry';
import type { Logger } from '../logging/logger';
import type { DocumentMetadata } from '@shared/types/document';

/**
 * The document-scoped services one IPC request is routed to. The library's own
 * set and every opened file's set have this shape, so a handler never needs to
 * know which store it is talking to.
 */
export type DocumentServices = {
  readonly library: LibraryService;
  readonly annotations: AnnotationRepository;
  readonly search: SearchRepository;
  readonly chat: ChatService;
};

export type OpenFileStoreDeps = {
  /** A fresh, main-owned staging directory that belongs to this store alone. */
  readonly root: string;
  readonly assetRegistry: AssetRegistry;
  readonly currentScopeId: () => string;
  /** The application's provider registry, borrowed rather than owned. */
  readonly providers: ChatProviderGateway;
  readonly resolveOpenRouterModelId: () => Promise<string | null>;
  /** The application's shared titler; titles live in this store's database. */
  readonly titler: ConversationTitler;
  readonly log: Logger;
};

/**
 * Lends the shared provider registry to a store's chat service without its
 * `shutdown`: disposing one opened file cancels that file's requests, but the
 * registry keeps serving the library and every later file.
 */
function borrowProviders(providers: ChatProviderGateway): ChatProviderGateway {
  return {
    listStatuses: (options) => providers.listStatuses(options),
    getStatus: (providerId, options) => providers.getStatus(providerId, options),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId),
    require: (providerId) => providers.require(providerId),
    testConnection: (providerId) => providers.testConnection(providerId),
    ...(providers.modelReasoning === undefined
      ? {}
      : { modelReasoning: (providerId, model) => providers.modelReasoning?.(providerId, model) ?? Promise.resolve(null) }),
  };
}

/**
 * One file opened without joining the library: its own in-memory database,
 * repository set, staged copy, and chat service. Nothing here touches the
 * library database, and disposal discards all of it.
 */
export class OpenFileStore {
  readonly services: DocumentServices;
  private readonly db: InterleafDatabase;
  private readonly chatRepository: ChatRepository;
  private readonly deps: OpenFileStoreDeps;
  private document: DocumentMetadata | null = null;
  private disposal: Promise<void> | null = null;

  private constructor(deps: OpenFileStoreDeps, db: InterleafDatabase, storage: StorageManager) {
    this.deps = deps;
    this.db = db;
    this.chatRepository = new ChatRepository(db);
    const library = new LibraryService({
      db,
      storage,
      documents: new DocumentRepository(db),
      folders: new FolderRepository(db),
      readingPositions: new ReadingPositionRepository(db),
      documentAssets: new DocumentAssetRepository(db),
      log: deps.log,
      assetRegistry: deps.assetRegistry,
      currentScopeId: deps.currentScopeId,
    });
    this.services = {
      library,
      annotations: new AnnotationRepository(db),
      search: new SearchRepository(db),
      chat: new ChatService({
        chat: this.chatRepository,
        context: new AIContextRepository(db),
        providers: borrowProviders(deps.providers),
        requireDocumentOpen: (documentId) => { library.requireDocumentOpen(documentId); },
        log: deps.log,
        resolveOpenRouterModelId: deps.resolveOpenRouterModelId,
        titles: deps.titler.forStore(new ChatTitleRepository(db)),
      }),
    };
  }

  static async create(deps: OpenFileStoreDeps): Promise<OpenFileStore> {
    await mkdir(deps.root, { recursive: true, mode: 0o700 });
    const storage = new StorageManager(deps.root, deps.log);
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      await storage.initialize();
    } catch (error) {
      db.close();
      await rm(deps.root, { recursive: true, force: true });
      throw error;
    }
    return new OpenFileStore(deps, db, storage);
  }

  get documentId(): string | null {
    return this.document?.id ?? null;
  }

  /**
   * Stages a private copy of the file and records it in this store. The
   * library's import path runs unchanged, so the same regular-file, size and
   * signature checks apply, and the original is only ever read.
   */
  async load(filePath: string): Promise<DocumentMetadata> {
    if (this.document !== null) throw new Error('An open-file store holds exactly one document.');
    this.document = await this.services.library.importFile(filePath, { storageMode: 'managed', folderId: null });
    return this.document;
  }

  ownsSession(sessionId: string): boolean {
    return this.disposal === null && this.chatRepository.getSession(sessionId) !== null;
  }

  /**
   * Cancels chat work, revokes every capability, closes the database and
   * deletes the staged copy, in that order. Idempotent.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    return this.disposal;
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this.services.chat.shutdown();
      const documentId = this.documentId;
      if (documentId !== null) {
        await this.services.library.closeDocument(documentId);
        this.deps.assetRegistry.unregisterDocument(documentId);
      }
    } finally {
      this.db.close();
      await rm(this.deps.root, { recursive: true, force: true });
    }
  }
}
