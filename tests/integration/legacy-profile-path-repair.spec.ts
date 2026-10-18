import { testSessionAuthority, testTargetIdentity } from '../helpers/agent-session-records';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BRAND_PROFILE_DIRECTORY_NAME,
  LEGACY_BRAND_PROFILE_DIRECTORY_NAME,
  migrateLegacyUserDataProfile,
} from '@main/app/legacy-profile-migration';
import { adoptLegacyDatabase, LEGACY_DATABASE_FILE_NAME } from '@main/db/legacy-database-migration';
import { InterleafDatabase, DATABASE_FILE_NAME } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { repairLegacyProfilePaths } from '@main/db/legacy-profile-path-repair';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { DocumentAssetRepository } from '@main/db/repositories/document-asset-repository';
import { FolderRepository } from '@main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '@main/db/repositories/reading-position-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { StorageManager } from '@main/library/storage-manager';
import { LibraryService } from '@main/library/library-service';
import { createLogger } from '@main/logging/logger';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { PdfAnnotationAnchor } from '@shared/types/annotation';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { silentLogger } from '../helpers/silent-logger';
import { AssetRegistry } from '../../src/main/security/asset-registry';

/**
 * The MarginLab → Interleaf rebrand moves the profile directory and renames the
 * database file, but every row inside that database still stores absolute paths
 * into the old profile. This suite runs the real adoption sequence against real
 * directories: seed a pre-rebrand profile with a managed import, an archived
 * asset, an annotation, a chat session and an agent session; restart into the
 * Interleaf profile; and then let managed-storage reconciliation run exactly as
 * bootstrap does.
 *
 * Without the path repair, reconciliation sees a library whose every blob is
 * referenced only by a path that no longer exists and deletes the user's files.
 */

const roots: string[] = [];
const openDatabases: InterleafDatabase[] = [];

function makeAppDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'interleaf-path-repair-'));
  roots.push(root);
  return root;
}

function track(database: InterleafDatabase): InterleafDatabase {
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    try {
      openDatabases.pop()?.close();
    } catch {
      // A test may already have closed it; cleanup must stay best-effort.
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const agentProfile: MainAgentProfile = {
  id: 'fake',
  providerId: 'fake',
  name: 'Fixture',
  binaryPath: '/usr/local/bin/fixture-agent',
  defaultArgs: [],
  defaultModel: null,
  reasoningEffort: null,
  permissionMode: 'fixture',
  defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true,
    sessionResume: false,
    nativeSandbox: true,
    workingDirectory: true,
    modelSelection: false,
    reasoningSelection: false,
    fileChangeEvents: true,
    toolEvents: true,
    subagents: false,
    interactiveAuthentication: false,
    nonInteractiveMode: true,
  },
  detection: {
    availability: 'installed',
    binaryPath: '/usr/local/bin/fixture-agent',
    version: 'test',
    checkedAt: new Date().toISOString(),
    errorMessage: null,
  },
  isCustom: false,
  unsafe: false,
};

function pdfAnchor(): PdfAnnotationAnchor {
  return {
    format: 'pdf',
    pageIndex: 0,
    quote: { exact: 'anchored text', prefix: 'before ', suffix: ' after' },
    textStart: 7,
    textEnd: 20,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
  };
}

function makeLibraryService(database: InterleafDatabase, libraryRoot: string): {
  readonly service: LibraryService;
  readonly documents: DocumentRepository;
  readonly assets: DocumentAssetRepository;
  readonly storage: StorageManager;
} {
  const log = createLogger('library');
  const storage = new StorageManager(libraryRoot, log);
  const documents = new DocumentRepository(database);
  const assets = new DocumentAssetRepository(database);
  const service = new LibraryService({
    db: database,
    storage,
    documents,
    folders: new FolderRepository(database),
    readingPositions: new ReadingPositionRepository(database),
    documentAssets: assets,
    log,
    assetRegistry: new AssetRegistry([libraryRoot]),
    currentScopeId: () => 'library-test-scope',
  });
  return { service, documents, assets, storage };
}

type SeededProfile = {
  readonly appDataRoot: string;
  readonly legacyRoot: string;
  readonly currentRoot: string;
  readonly documentId: string;
  readonly annotationId: string;
  readonly chatSessionId: string;
  readonly agentSessionId: string;
  readonly assetReference: string;
  readonly externalLinkPath: string;
  readonly siblingPrefixPath: string;
  readonly legacyManagedPath: string;
  readonly legacyAssetPath: string;
};

/**
 * Builds a profile the way the pre-rebrand application would have left it: a
 * real managed copy in `<appData>/MarginLab/library`, a real archived image,
 * and the document-scoped rows a user would expect to still have afterwards.
 */
async function seedLegacyProfile(): Promise<SeededProfile> {
  const appDataRoot = makeAppDataRoot();
  const legacyRoot = join(appDataRoot, LEGACY_BRAND_PROFILE_DIRECTORY_NAME);
  const legacyDatabaseDir = join(legacyRoot, 'database');
  const legacyLibrary = join(legacyRoot, 'library');
  mkdirSync(legacyDatabaseDir, { recursive: true });
  const database = track(InterleafDatabase.open(join(legacyDatabaseDir, LEGACY_DATABASE_FILE_NAME)));
  runMigrations(database);

  const { service, documents, assets, storage } = makeLibraryService(database, legacyLibrary);
  await storage.initialize();

  const sourcePath = join(appDataRoot, 'Imported Book.pdf');
  writeFileSync(sourcePath, makePdfFixture({ title: 'Imported Book', author: 'A. Writer' }));
  const imported = await service.importFile(sourcePath, { folderId: null, storageMode: 'managed' });
  const legacyManagedPath = documents.findById(imported.id)?.filePath ?? '';

  // An archived article image: same content-addressed tree, referenced by a
  // row rather than by the document's own file_path.
  const archived = await storage.ingestGeneratedContent(Buffer.from('archived-image-bytes'), '.png');
  const assetReference = `interleaf-asset:${archived.fileHash}.png`;
  assets.replaceForDocument(imported.id, [
    {
      reference: assetReference,
      assetHash: archived.fileHash,
      extension: '.png',
      mimeType: 'image/png',
      filePath: archived.finalPath,
      byteSize: archived.fileSize,
      width: 10,
      height: 10,
    },
  ]);
  // Covers are generated beside the library; the column is app-owned too.
  database.raw
    .prepare('UPDATE documents SET cover_path = ? WHERE id = ?')
    .run(join(legacyLibrary, '.covers', `${imported.fileHash}.png`), imported.id);

  // Two paths that merely contain the old brand name and belong to the user:
  // an external link-mode document and a sibling of the profile directory.
  const externalLinkPath = join(appDataRoot, 'Documents', 'MarginLab', 'external.pdf');
  const siblingPrefixPath = join(appDataRoot, `${LEGACY_BRAND_PROFILE_DIRECTORY_NAME}Notes`, 'notes.pdf');
  documents.insert({
    id: 'doc-external-link',
    title: 'External',
    author: null,
    format: 'pdf',
    filePath: externalLinkPath,
    storageMode: 'link',
    fileSize: 10,
    fileMtimeMs: 1,
    fileHash: 'external-hash',
    pageCount: 1,
  });
  documents.insert({
    id: 'doc-sibling-prefix',
    title: 'Sibling',
    author: null,
    format: 'pdf',
    filePath: siblingPrefixPath,
    storageMode: 'link',
    fileSize: 10,
    fileMtimeMs: 1,
    fileHash: 'sibling-hash',
    pageCount: 1,
  });

  const annotation = new AnnotationRepository(database).create({
    documentId: imported.id,
    type: 'highlight',
    anchor: pdfAnchor(),
    selectedText: 'anchored text',
    note: 'keep me',
    color: 'yellow',
  });
  const chat = new ChatRepository(database);
  const chatSession = chat.createSession({ documentId: imported.id, providerId: 'fake', title: 'Reading notes' });
  const agents = new AgentRepository(database);
  agents.upsertProfile(agentProfile);
  agents.registerWorkingDirectory({
    handle: 'dir-handle',
    canonicalPath: join(appDataRoot, 'projects', 'thesis'),
    displayName: 'thesis',
    device: 1,
    inode: 2,
    birthtimeNs: '3',
  });
  const agentSession = agents.createSession({
    documentId: imported.id,
    profileId: agentProfile.id,
    providerId: agentProfile.providerId,
    targetDirectory: { handle: 'dir-handle', displayName: 'thesis' },
    canonicalTargetPath: join(appDataRoot, 'projects', 'thesis'),
    sandboxMode: 'isolated-copy',
    userPrompt: 'summarize chapter one',
    baselineFingerprint: 'fingerprint', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
  });

  database.close();
  return {
    appDataRoot,
    legacyRoot,
    currentRoot: join(appDataRoot, BRAND_PROFILE_DIRECTORY_NAME),
    documentId: imported.id,
    annotationId: annotation.id,
    chatSessionId: chatSession.id,
    agentSessionId: agentSession.id,
    assetReference,
    externalLinkPath,
    siblingPrefixPath,
    legacyManagedPath,
    legacyAssetPath: archived.finalPath,
  };
}

/**
 * The bootstrap sequence a restart performs: adopt the profile, adopt the
 * database, migrate, rebase legacy paths, then reconcile managed storage.
 */
async function restartOnAdoptedProfile(
  seeded: SeededProfile,
  options?: { readonly repair?: boolean },
): Promise<{
  readonly database: InterleafDatabase;
  readonly service: LibraryService;
  readonly documents: DocumentRepository;
  readonly assets: DocumentAssetRepository;
  readonly removed: number;
  /** Canonical profile root, which is the form stored paths take. */
  readonly currentRoot: string;
}> {
  expect(migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: seeded.appDataRoot }).outcome).toBe('migrated');
  const databaseDirectory = join(seeded.currentRoot, 'database');
  expect(
    adoptLegacyDatabase({ log: silentLogger, databaseDirectory, currentFileName: DATABASE_FILE_NAME }).outcome,
  ).toBe('migrated');

  const database = track(InterleafDatabase.open(join(databaseDirectory, DATABASE_FILE_NAME)));
  runMigrations(database);
  if (options?.repair !== false) {
    repairLegacyProfilePaths({
      log: silentLogger,
      db: database,
      legacyUserDataRoot: seeded.legacyRoot,
      currentUserDataRoot: seeded.currentRoot,
    });
  }

  const { service, documents, assets, storage } = makeLibraryService(
    database,
    join(seeded.currentRoot, 'library'),
  );
  await storage.initialize();
  // Age threshold 0: bootstrap's sweep would reach the same files after the
  // ten-minute grace period, and the outcome must not depend on waiting.
  const removed = await service.reconcileManagedStorage(0);
  return { database, service, documents, assets, removed, currentRoot: realpathSync(seeded.currentRoot) };
}

describe('pre-rebrand profile path repair', () => {
  it('keeps the adopted library referenced and healthy through reconciliation', async () => {
    const seeded = await seedLegacyProfile();

    const restarted = await restartOnAdoptedProfile(seeded);

    const currentLibrary = join(restarted.currentRoot, 'library');
    const document = restarted.documents.findById(seeded.documentId);
    expect(document?.filePath.startsWith(`${currentLibrary}/`)).toBe(true);
    expect(existsSync(document?.filePath ?? '')).toBe(true);
    const asset = restarted.assets.listForDocument(seeded.documentId)[0];
    expect(asset?.filePath.startsWith(`${currentLibrary}/`)).toBe(true);
    expect(existsSync(asset?.filePath ?? '')).toBe(true);
    expect(restarted.removed).toBe(0);

    // `getDocument` runs the real content check rather than the optimistic
    // immediate one the list view uses.
    const reopened = await restarted.service.getDocument(seeded.documentId);
    expect(reopened?.storageHealth).toBe('ok');
    expect(reopened?.title).toBe('Imported Book');
  });

  it('deletes the referenced library when the stale legacy paths are not rebased', async () => {
    const seeded = await seedLegacyProfile();

    // The unrepaired path: every row still points into `<appData>/MarginLab`,
    // so reconciliation cannot see a reference to anything it finds.
    const restarted = await restartOnAdoptedProfile(seeded, { repair: false });

    expect(restarted.removed).toBeGreaterThan(0);
    expect(existsSync(restarted.documents.findById(seeded.documentId)?.filePath ?? '')).toBe(false);
    expect((await restarted.service.getDocument(seeded.documentId))?.storageHealth).toBe('missing');
  });

  it('preserves the document, annotation, chat, and agent rows and their relationships', async () => {
    const seeded = await seedLegacyProfile();

    const restarted = await restartOnAdoptedProfile(seeded);

    const annotations = new AnnotationRepository(restarted.database).list(seeded.documentId);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.id).toBe(seeded.annotationId);
    expect(annotations[0]?.note).toBe('keep me');

    const chatSession = new ChatRepository(restarted.database).getSessionForDocument(
      seeded.chatSessionId,
      seeded.documentId,
    );
    expect(chatSession?.title).toBe('Reading notes');

    const agentSession = new AgentRepository(restarted.database).getSessionDetail(seeded.agentSessionId);
    expect(agentSession?.documentId).toBe(seeded.documentId);
    expect(agentSession?.userPrompt).toBe('summarize chapter one');

    const counts = restarted.database.raw
      .prepare(
        `SELECT (SELECT COUNT(*) FROM documents) AS documents,
                (SELECT COUNT(*) FROM annotations) AS annotations,
                (SELECT COUNT(*) FROM chat_sessions) AS chats,
                (SELECT COUNT(*) FROM agent_sessions) AS agents,
                (SELECT COUNT(*) FROM document_assets) AS assets`,
      )
      .get() as Record<string, number>;
    expect(counts).toEqual({ documents: 3, annotations: 1, chats: 1, agents: 1, assets: 1 });
  });

  it('never rewrites a user path that only contains the old brand name', async () => {
    const seeded = await seedLegacyProfile();

    const restarted = await restartOnAdoptedProfile(seeded);

    expect(restarted.documents.findById('doc-external-link')?.filePath).toBe(seeded.externalLinkPath);
    expect(restarted.documents.findById('doc-sibling-prefix')?.filePath).toBe(seeded.siblingPrefixPath);
    // A user working directory is not an app-owned path either.
    const directory = restarted.database.raw
      .prepare('SELECT canonical_path FROM allowed_working_directories')
      .get() as { canonical_path: string } | undefined;
    expect(directory?.canonical_path).toBe(join(seeded.appDataRoot, 'projects', 'thesis'));
    expect(
      (restarted.database.raw.prepare('SELECT binary_path FROM agent_profiles').get() as
        | { binary_path: string }
        | undefined)?.binary_path,
    ).toBe('/usr/local/bin/fixture-agent');
  });

  it('is a no-op when run again', async () => {
    const seeded = await seedLegacyProfile();
    const restarted = await restartOnAdoptedProfile(seeded);
    const before = restarted.documents.findById(seeded.documentId)?.filePath;
    const coverBefore = restarted.database.raw
      .prepare('SELECT cover_path FROM documents WHERE id = ?')
      .get(seeded.documentId) as { cover_path: string } | undefined;

    const second = repairLegacyProfilePaths({
      log: silentLogger,
      db: restarted.database,
      legacyUserDataRoot: seeded.legacyRoot,
      currentUserDataRoot: seeded.currentRoot,
    });

    expect(second).toEqual({
      outcome: 'no-legacy-paths',
      documentFiles: 0,
      coverSnapshots: 0,
      documentAssets: 0,
    });
    expect(restarted.documents.findById(seeded.documentId)?.filePath).toBe(before);
    expect(coverBefore?.cover_path).toBe(
      join(restarted.currentRoot, 'library', '.covers', `${restarted.documents.findById(seeded.documentId)?.fileHash ?? ''}.png`),
    );
  });

  it('rebases the generated cover path and reports what it changed', async () => {
    const seeded = await seedLegacyProfile();
    expect(migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: seeded.appDataRoot }).outcome).toBe('migrated');
    const databaseDirectory = join(seeded.currentRoot, 'database');
    adoptLegacyDatabase({ log: silentLogger, databaseDirectory, currentFileName: DATABASE_FILE_NAME });
    const database = track(InterleafDatabase.open(join(databaseDirectory, DATABASE_FILE_NAME)));
    runMigrations(database);

    const result = repairLegacyProfilePaths({
      log: silentLogger,
      db: database,
      legacyUserDataRoot: seeded.legacyRoot,
      currentUserDataRoot: seeded.currentRoot,
    });

    expect(result).toEqual({
      outcome: 'repaired',
      documentFiles: 1,
      coverSnapshots: 1,
      documentAssets: 1,
    });
    const cover = database.raw
      .prepare('SELECT cover_path FROM documents WHERE id = ?')
      .get(seeded.documentId) as { cover_path: string } | undefined;
    expect(
      cover?.cover_path.startsWith(join(realpathSync(seeded.currentRoot), 'library', '.covers')),
    ).toBe(true);
    // The adopted blob keeps its bytes; only the stored location changed.
    const rebased = new DocumentRepository(database).findById(seeded.documentId)?.filePath ?? '';
    expect(readFileSync(rebased).byteLength).toBeGreaterThan(0);
  });
});
