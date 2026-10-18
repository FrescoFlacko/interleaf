import {
  MAX_WEB_ARTICLE_SITE_NAME_LENGTH,
  MAX_WEB_ARTICLE_URL_LENGTH,
} from '@shared/constants/web-article';

/**
 * Additive provenance columns for documents Interleaf captured itself.
 *
 * Existing rows keep `NULL` in every new column and are never rewritten: a
 * user's imported files stay exactly as they were, and `NULL` means "the user
 * supplied this file". The columns are separate and bounded rather than a JSON
 * blob so the repository can read them as typed values and the library can
 * filter on origin later without parsing untrusted text at query time.
 */
/** The authority of `source_url`: everything between `//` and the next `/`. */
const SOURCE_URL_AUTHORITY = `substr(
       substr(NEW.source_url, instr(NEW.source_url, '//') + 2),
       1,
       instr(substr(NEW.source_url, instr(NEW.source_url, '//') + 2), '/') - 1
     )`;

/**
 * What makes a source row incoherent, in SQL.
 *
 * The schema in `@shared/schemas/document` is the primary validator and every
 * write goes through it. This restates the parts a table can check by itself so
 * a row that skipped that path — a future code path, a repair script, someone
 * at a `sqlite3` prompt — still cannot leave provenance that the reader would
 * later have to distrust. It is a floor, not a substitute: SQL cannot resolve a
 * host or re-serialize a URL, so canonical form is enforced above.
 */
const INCOHERENT_DOCUMENT_SOURCE = `
     -- A document with no source must carry no source columns.
     (NEW.source_kind IS NULL AND (NEW.source_url IS NOT NULL OR NEW.source_site_name IS NOT NULL OR NEW.source_captured_at IS NOT NULL))
     OR (NEW.source_kind = 'web' AND (
       -- A web document must say where and when it came from.
       NEW.source_url IS NULL
       OR NEW.source_captured_at IS NULL
       -- Bounded, absolute http(s), and nothing but the address itself.
       OR length(NEW.source_url) > ${String(MAX_WEB_ARTICLE_URL_LENGTH)}
       OR NOT (NEW.source_url GLOB 'http://?*' OR NEW.source_url GLOB 'https://?*')
       OR instr(NEW.source_url, '#') > 0
       OR NEW.source_url GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
       -- No credentials: no '@' inside the authority.
       OR instr(${SOURCE_URL_AUTHORITY}, '@') > 0
       OR length(${SOURCE_URL_AUTHORITY}) = 0
       -- An ISO-8601 instant, not free text.
       OR NOT NEW.source_captured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
       OR length(NEW.source_captured_at) > 40
       -- A site name, when present, is bounded single-line text.
       OR (NEW.source_site_name IS NOT NULL AND (
         length(NEW.source_site_name) = 0
         OR length(NEW.source_site_name) > ${String(MAX_WEB_ARTICLE_SITE_NAME_LENGTH)}
         OR NEW.source_site_name GLOB '*[' || char(9) || char(10) || char(13) || ']*'
       ))
     ))`;

const INCOHERENT_DOCUMENT_SOURCE_MESSAGE =
  'Incoherent document source: a web document needs a bounded http(s) source_url with no fragment or credentials, an ISO source_captured_at, and a bounded single-line source_site_name; a non-web document must leave every source column null';

export const DOCUMENT_WEB_SOURCE_STATEMENTS: readonly string[] = [
  `ALTER TABLE documents ADD COLUMN source_kind TEXT CHECK(source_kind IS NULL OR source_kind IN ('web'))`,
  `ALTER TABLE documents ADD COLUMN source_url TEXT`,
  `ALTER TABLE documents ADD COLUMN source_site_name TEXT`,
  `ALTER TABLE documents ADD COLUMN source_captured_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_documents_source_kind ON documents(source_kind)`,
  `CREATE TRIGGER IF NOT EXISTS validate_documents_source_coherence_insert
   BEFORE INSERT ON documents
   FOR EACH ROW
   WHEN (${INCOHERENT_DOCUMENT_SOURCE}
   )
   BEGIN
     SELECT RAISE(ABORT, '${INCOHERENT_DOCUMENT_SOURCE_MESSAGE}');
   END`,
  // Every source column is listed, so changing any one of them re-checks the
  // whole row rather than only the column that moved.
  `CREATE TRIGGER IF NOT EXISTS validate_documents_source_coherence_update
   BEFORE UPDATE OF source_kind, source_url, source_site_name, source_captured_at ON documents
   FOR EACH ROW
   WHEN (${INCOHERENT_DOCUMENT_SOURCE}
   )
   BEGIN
     SELECT RAISE(ABORT, '${INCOHERENT_DOCUMENT_SOURCE_MESSAGE}');
   END`,
];
