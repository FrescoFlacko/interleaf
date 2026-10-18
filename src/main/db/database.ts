import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { caseFold } from 'unicode-case-folding';
import { fieldsMatchAllSearchTerms } from '@shared/search/text-match';

/**
 * Main-process SQLite ownership (ADR-0004). The renderer never sees this
 * module; all access flows through typed repositories.
 *
 * Uses Node's built-in `node:sqlite` (available in Electron 43's Node 24
 * runtime with FTS5 enabled), which avoids shipping a native module that
 * would need ABI-specific rebuilds.
 */

export const DATABASE_FILE_NAME = 'interleaf.sqlite';

export function normalizeFolderNameKey(value: string): string {
  return caseFold(value.normalize('NFKC')).normalize('NFKC');
}

type PragmaSnapshot = { readonly journalMode: string;
readonly foreignKeys: boolean; }

export class InterleafDatabase {
  private constructor(private readonly db: DatabaseSync) {}

  static open(databasePath: string): InterleafDatabase {
    const db = new DatabaseSync(databasePath);
    // Persisted-schema identifier, deliberately not rebranded. The
    // `folders_name_key_*_guard` triggers created by migrations 6 and 7 call
    // this function by name and live in `sqlite_master`; the migration text is
    // also checksummed for drift detection. Renaming either side would break
    // every folder insert/update in a database created before the Interleaf
    // rename. See the header comment in src/main/db/migrations.ts.
    db.function(
      'marginlab_folder_name_key',
      { deterministic: true },
      (value: SQLOutputValue) => (typeof value === 'string' ? normalizeFolderNameKey(value) : '')
    );
    // Exact whole-token search predicate. `document_fts` is tokenized with
    // `porter unicode61`, so `MATCH` alone also returns stem relatives
    // (`formatting` for a `format` query). Registering the exact test as a
    // deterministic SQL function lets `SearchRepository.search` apply it inside
    // the statement, before ORDER BY and LIMIT — a JS post-filter would return
    // fewer rows than the caller asked for and silently reorder results.
    db.function(
      'interleaf_search_exact_terms',
      { deterministic: true },
      (text: SQLOutputValue, heading: SQLOutputValue, query: SQLOutputValue) =>
        typeof query === 'string' && fieldsMatchAllSearchTerms([
          typeof text === 'string' ? text : null,
          typeof heading === 'string' ? heading : null,
        ], query)
          ? 1
          : 0
    );
    // Pragmas per docs/DATABASE.md §1 — WAL durability + referential integrity.
    const isInMemory = databasePath === ':memory:';
    if (!isInMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA cache_size = -64000;');

    const snapshot = readPragmas(db);
    if (!isInMemory && snapshot.journalMode.toLowerCase() !== 'wal') {
      db.close();
      throw new Error(`Failed to enable WAL mode (journal_mode=${snapshot.journalMode}).`);
    }
    if (!snapshot.foreignKeys) {
      db.close();
      throw new Error('Failed to enable PRAGMA foreign_keys.');
    }
    return new InterleafDatabase(db);
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

function readPragmas(db: DatabaseSync): PragmaSnapshot {
  const journalRow = db.prepare('PRAGMA journal_mode').get() as
    | { journal_mode?: SQLOutputValue }
    | undefined;
  const fkRow = db.prepare('PRAGMA foreign_keys').get() as
    | { foreign_keys?: SQLOutputValue }
    | undefined;
  return {
    journalMode: typeof journalRow?.journal_mode === 'string' ? journalRow.journal_mode : '',
    foreignKeys: fkRow?.foreign_keys === 1,
  };
}
