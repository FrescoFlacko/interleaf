# ADR 0010: Managed Library vs Link-in-Place Document Storage

## Status
Accepted

## Context & Problem Statement
When a user imports a PDF, EPUB, MOBI, or DOCX document into Interleaf, the application must choose how to store and reference the binary file. If Interleaf only stores a path reference to the original file, user moves, renames, or deletions in the OS file manager will break the library and orphan annotations. Conversely, forcing all files into managed storage duplicates large binaries on disk.

## Decision Drivers
- High data safety and resilience: annotations and reading progress must never be broken by external file operations.
- Content deduplication: importing the same file multiple times should not consume redundant disk space.
- Flexibility: allow power users to reference existing folder trees (e.g. Calibre libraries, research folders) without duplication.

## Considered Options
1. **Option 1: Link-in-Place Only** — Store only the absolute path to the imported file. (Rejected: Fragile; breaking paths orphan notes).
2. **Option 2: Managed Copy Only** — Always copy every document into Interleaf's data directory. (Rejected: Inflexible for users managing large local document archives).
3. **Option 3: Hybrid Ingestion Model (Managed Copy Default + Link-in-Place Option)** —
   - Default: Copy files to `<userData>/library/<hash[0..1]>/<hash>.<ext>` with SHA-256 content addressing and deduplication.
   - Option: Allow explicit Link-in-Place with SHA-256 drift detection.

## Decision Outcome
Chosen **Option 3**.

### Storage Architecture & Invariants
```
<userData>/library/
├── 3f/
│   └── 3f8a92...pdf   <── Content-addressed by SHA-256 hash
└── c4/
    └── c4b109...epub
```

1. **Managed Copy Mode (Default)**:
   - File is copied into `<userData>/library/`.
   - File is named after its SHA-256 hash. If an identical binary is imported again, Interleaf reuses its single logical document record and updates that record's primary folder and explicitly selected storage mode instead of creating a duplicate row.
   - Guarantees immutable document integrity.
2. **Link-in-Place Mode (Optional)**:
   - Stores original filesystem path, file size, last modified timestamp, and SHA-256 hash.
   - On document open, Interleaf checks file existence and verifies the hash. If the file has moved, Interleaf prompts the user to locate the missing file.

## Consequences
- **Positive**: Standard users experience rock-solid library stability where documents never disappear.
- **Positive**: SHA-256 deduplication saves disk space and prevents duplicate logical records; the MVP assigns each document one primary virtual folder.
- **Negative**: Managed copy requires disk space proportional to imported documents.
