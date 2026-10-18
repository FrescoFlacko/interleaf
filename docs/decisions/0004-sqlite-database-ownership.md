# ADR 0004: SQLite Database Ownership in Main Process

## Status
Accepted

## Context & Problem Statement
Interleaf requires persistent local relational storage for document library metadata, virtual folders, annotations, bookmarks, reading progress, full-text search indexes (FTS5), AI conversations, and agent session history. Allowing the untrusted renderer process to execute raw SQL queries (`executeSql(query)`) would open severe SQL injection vulnerabilities and complicate database concurrency and WAL file locking.

## Decision Drivers
- High-performance, concurrent embedded database with ACID guarantees.
- Elimination of SQL injection vectors across process boundaries.
- Adherence to the `database-design` skill guidelines (WAL mode, foreign keys, index optimization).
- Single source of truth with strict repository encapsulation.

## Considered Options
1. **Option 1: Renderer-Side Database (IndexedDB / WASM SQLite)** — Store database inside Chromium renderer storage. (Fragile persistence, potential browser eviction, poor concurrency with Node CLI tooling).
2. **Option 2: Raw SQL IPC Bridge (`executeSql`)** — Expose a generic SQL query channel over IPC to the renderer. (Critical security vulnerability; untrusted renderer can drop tables or exfiltrate private data).
3. **Option 3: Main-Process-Only SQLite with Typed Repositories** — SQLite managed exclusively in the main process using WAL mode; renderer interacts solely via high-level typed domain commands.

## Decision Outcome
Chosen **Option 3**.

### Architectural Invariants
1. **Exclusive Main Ownership**: SQLite database file (`<userData>/database/interleaf.sqlite`) is opened and managed strictly within the main process using `better-sqlite3` or Node 22 native `node:sqlite`.
2. **Pragmas**:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   PRAGMA foreign_keys = ON;
   PRAGMA busy_timeout = 5000;
   ```
3. **Domain Repository Pattern**: All database operations are encapsulated in strongly typed repository classes (`DocumentRepository`, `AnnotationRepository`, `ChatRepository`, `AgentRepository`).
4. **No Raw SQL over IPC**: The preload bridge exposes only domain-specific methods (`annotations.create`, `library.importDocument`). No SQL strings are passed over IPC.

## Consequences
- **Positive**: A materially smaller SQL attack surface because the renderer cannot submit raw SQL.
- **Positive**: WAL permits concurrent readers while the sole main-process writer coordinates background indexing and other transactions.
- **Negative**: Every new query requires adding a typed repository method and corresponding IPC handler.
