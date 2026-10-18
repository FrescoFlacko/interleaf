# ADR 0008: Sandboxing & Workspace Isolation Strategy

## Status
Accepted

## Context & Problem Statement
AI coding agents generate code, modify files, install packages, and execute test suites. Running agents directly inside a user's active, uncommitted working directory risks accidental code deletion, dirty git trees, or unintended file overwrites. Interleaf requires a robust workspace isolation model that prevents destructive modifications by default while offering power users direct execution when explicitly desired.

## Decision Drivers
- Non-destructive execution by default: running an agent should never silently mutate primary project files.
- Support for both Git repositories and non-Git project directories.
- Seamless review surface: users must be able to inspect unified diffs and test results before applying changes.
- Explicit risk elevation and deliberate confirmation for direct active-environment execution.

## Considered Options
1. **Option 1: Direct Active Directory Execution Only** — Run all agents directly in the user's project folder. (Rejected: High risk of unrecoverable data loss).
2. **Option 2: Container-Only Sandboxing** — Require Docker/Podman for every agent task. (Rejected: Fails when Docker is not installed or running).
3. **Option 3: Multi-Tier Workspace Isolation with Worktree Default** —
   - Default for Git repositories: **Isolated Worktree** (`git worktree`).
   - Default for non-Git projects: **Isolated Directory Copy**.
   - Direct execution (**Active Environment**) requires deliberate selection and confirmation.
   - A future **Container Sandbox** only after a verified executor exists;
     merely detecting Docker/Podman is insufficient.

## Decision Outcome
Chosen **Option 3**.

The persisted/default request is `auto-isolated`, resolved only in main after validating a registered working-directory handle: Git → `isolated-worktree`; non-Git → `isolated-copy`; preparation failure → fail closed. The runtime never falls back to `active-env`. Direct or bypass execution requires a short-lived, single-use confirmation grant bound to the exact target/profile/mode/session.

### Execution Mode Hierarchy & Invariants
```
┌────────────────────────┬─────────────────────┬───────────────────┬────────────────────────────────┐
│ Mode                   │ Applicable Target   │ Default Status    │ Risk Level & Safety Invariant  │
├────────────────────────┼─────────────────────┼───────────────────┼────────────────────────────────┤
│ **Isolated Worktree**  │ Git Repositories    │ **Default**       │ **MEDIUM**: Creates temporary  │
│ (`isolated-worktree`)  │                     │                   │ worktree branch; zero dirty    │
│                        │                     │                   │ changes in main worktree.      │
├────────────────────────┼─────────────────────┼───────────────────┼────────────────────────────────┤
│ **Isolated Directory   │ Non-Git Directories │ **Default (Auto)**│ **MEDIUM**: Duplicates files   │
│ Copy** (`isolated-copy`)│                    │                   │ to temp dir; computes delta.   │
├────────────────────────┼─────────────────────┼───────────────────┼────────────────────────────────┤
│ **Native Restricted**  │ Agent-Supported     │ Optional          │ **MEDIUM**: Uses CLI's built-in│
│ (`native-restricted`)  │ Workspaces          │                   │ sandbox (e.g. workspace-write).│
├────────────────────────┼─────────────────────┼───────────────────┼────────────────────────────────┤
│ **Container Sandbox**  │ Docker/Podman Hosts │ **Unavailable**   │ **LOW when implemented**:     │
│ (`container-sandbox`)  │                     │ **fail-closed**   │ rootless bounded executor;     │
│                        │                     │                   │ detection alone does not run.  │
├────────────────────────┼─────────────────────┼───────────────────┼────────────────────────────────┤
│ **Active Environment** │ Any Directory       │ **Deliberate      │ **HIGH / CRITICAL**: Direct    │
│ (`active-env`)         │                     │ **Selection Only**│ write access to user folder;   │
│                        │                     │                   │ requires explicit modal ack.   │
└────────────────────────┴─────────────────────┴───────────────────┴────────────────────────────────┘
```

### Change Review & Application Lifecycle
1. **Baseline**: Capture canonical target identity, Git base/primary HEAD and clean state, or a non-Git hash/mode/symlink manifest. Serialize lifecycle transitions with a per-target lock.
2. **Isolated Execution**: Agent executes only inside a proven app-owned `<userData>/agent-workspaces/<sessionId>` path. Dirty Git work is excluded unless a future explicit snapshot feature safely imports it; apply stays disabled while the primary tree is dirty.
3. **Diff Generation**: Compute a bounded typed delta against the immutable baseline and reject traversal/escaping symlink paths.
4. **Interactive Review**: User inspects changed/untracked/deleted files, syntax diffs, and test output.
5. **User Action**:
   - `Apply Changes`: Reacquire the lock; revalidate path/repository identity, HEAD/base, cleanliness, hashes, and collisions. Preflight in a disposable worktree or staged copy. Drift/conflict blocks apply and offers export/re-run; it never overwrites or silently rebases newer user work. Directory copies use recovery backups and atomic same-volume replacement with full rollback.
   - `Export Patch`: Saves changes as `.patch` file.
   - `Discard Sandbox`: Idempotently remove only a session path proven beneath the app workspace root, prune its temporary branch/worktree metadata, and retry abandoned cleanup at startup.

## Consequences
- **Positive**: Default isolation materially reduces accidental mutation of the primary workspace.
- **Positive**: Git worktrees are fast because they share the repository's Git object storage while keeping separate checked-out working files.
- **Negative**: Non-Git directory copies may take additional disk space and time on large repositories (mitigated by excluding `node_modules` / `.git` / build folders).
