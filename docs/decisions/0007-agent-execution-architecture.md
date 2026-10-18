# ADR 0007: Agent Execution Architecture & CLI Orchestration

## Status
Accepted

## Context & Problem Statement
Interleaf enables users to submit document excerpts, notes, and architectural specifications directly to external coding agent CLIs (Codex, Claude Code, Antigravity, Copilot, OpenCode) to execute implementation tasks. Because agent CLIs have divergent command-line flags, streaming output formats, and session management capabilities, the runtime must abstract execution safely without introducing shell injection or workspace pollution risks.

## Decision Drivers
- Universal agent adapter contract supporting diverse external CLI binaries.
- Immunity from shell injection vulnerabilities across all prompt, file, and argument inputs.
- Real-time streaming of stdout, stderr, tool calls, and structured file changes.
- Safe lifecycle management (start, cancel, resume, timeout, process group termination).
- Strict isolation of temporary context files from the target repository's Git history.

## Considered Options
1. **Option 1: Shell String Interpolation (`exec`)** — Construct command strings via `sh -c "codex ${prompt}"`. (Rejected: Severe shell injection vulnerability).
2. **Option 2: PTY-Only Execution (`node-pty`)** — Force all execution through pseudo-terminals. (Rejected: Heavyweight, difficult to parse structured JSON events, terminal escape sequence bloat).
3. **Option 3: Tokenized Subprocess Spawning with Adapter Normalization** — Use `child_process.spawn` with `shell: false` and tokenized `argv: string[]` arrays. Abstract CLI differences behind an `AgentAdapter` interface.

## Decision Outcome
Chosen **Option 3**.

### Architectural Invariants
1. **Subprocess Invariant**:
   ```typescript
   spawn(binaryPath, argsArray, {
     cwd: workingDirectory,
     env: sanitizedEnvironment,
     shell: false, // MANDATORY: Never run through shell interpreter
     stdio: ['pipe', 'pipe', 'pipe']
   });
   ```
2. **Context Packet Isolation**: The renderer constructs a typed `AgentContextPacket` from the selected reader passage. Main validates the packet, writes a bounded owner-only JSON file under `<userData>/agent-workspaces/context/<sessionId>.json`, and delivers the prompt through stdin or a bounded argv value. Context files are NEVER written into the target project repository (`README.md`, `AGENTS.md`, `.git/`).
3. **Structured Event Streaming**: Adapters parse CLI output into normalized `AgentEvent` streams (`stdout`, `stderr`, `tool_call`, `file_change`, `test_result`, `status`).
4. **Graceful Process Termination**: Cancellation sends `SIGTERM`, escalates to
   `SIGKILL` after the bounded grace period, and reaps the POSIX process group
   (with the platform-specific child termination path on Windows).
5. **Environment Minimization**: `sanitizedEnvironment` is built from a platform allowlist plus explicitly approved provider variables. It never spreads `process.env`; custom profiles may only clear variables or inherit from the explicit platform allowlist. No environment values or secret override mechanism is exposed through profile JSON.
6. **Bounded Runtime**: Adapters enforce configurable timeouts, output/event
   size caps, and backpressure. (Amended 2026-09: user-started agent
   start/resume runs carry no total wall-clock deadline and end only when the
   child exits, the user cancels, or Interleaf shuts down; bounded short-lived
   probes, helper runs, and tests pass explicit finite timeouts that
   `ProcessRunner` enforces exactly. Output/event size caps, cancellation, and
   process-tree termination are unchanged.) Windows cancellation invokes the
   trusted absolute `%SystemRoot%\System32\taskkill.exe` with exact
   `/PID <digits> /T` and bounded `/F` escalation; helper failure remains
   fail-closed because direct-child exit does not prove tree reaping. POSIX
   uses a dedicated process group.
7. **Main-Owned Privilege Resolution**: Renderer requests contain domain IDs, task text, and the validated packet data, not context-file paths or canonical target paths. Main resolves registered directories, validates/persists the packet, and requires a short-lived confirmation grant bound to any active-environment or bypass run.
8. **Profile Preference Boundary**: Settings may select only a known adapter's allowlisted argv preset, model/reasoning defaults, permission label, safe sandbox default, opaque working-directory policy, and non-secret environment inherit/clear entries. The main process retains detected binary paths and validates every profile update. Custom executable profile create/update/delete is available through dedicated typed IPC with a main-owned native executable picker, identity revalidation, whole-token argv templates, and explicit unsafe confirmation. Normal mode is never arbitrary shell configuration; shell execution exists only through the separately gated Expert Shell path described below.

The Settings UI edits custom profiles, strictly discriminated into normal mode
and expert shell mode:
- **Normal Mode (`executionKind: 'normal'`)**: Uses whole-token argv templates with
  `shell: false`, stdin or bounded temp-file prompt delivery, text/JSON-lines
  stdout parsing, and rejects shell-only fields, direct shell binaries (`sh`,
  `bash`, `zsh`, `pwsh`, `cmd`), and eval flags (`-c`, `/c`, `-Command`).
- **Expert Shell Mode (`executionKind: 'expert-shell'`)**: Separate dangerous
  path for power users. Executes validated shell binaries with fixed tokenized
  family arguments (`-lc COMMAND`, `-NoProfile -NonInteractive -Command COMMAND`,
  `/d /s /c COMMAND`) and Node `shell: false`. No command string interpolation;
  prompts are delivered strictly on stdin. Main-owned bounded values are exposed
  as minimal environment variables (`INTERLEAF_SESSION_ID`, `INTERLEAF_RUN_ID`,
  `INTERLEAF_MODEL`, `INTERLEAF_REASONING_EFFORT`, `INTERLEAF_WORKING_DIR`). Those
  runtime values are ordinary local diagnostics — a child that prints them stays
  readable, while credential-shaped output still redacts. Requires dedicated native
  warning on creation/transition and fresh native confirmation on start and resume.

Session start persists exact effective model and reasoning effort snapshots in
schema migration v12 (`agent_sessions.effective_model`, `effective_reasoning_effort`).
Resume always reuses this session snapshot, avoiding drift from subsequent profile edits.
## Amendment 2026-09: unbounded user sessions and readable local diagnostics

Two user-authorized product decisions revise this ADR for the agent output
surface:

1. A user-started Agent session is not interrupted by a fixed total runtime
   timeout (the former 15-minute default). Explicit finite timeouts remain
   required for model-discovery probes, tests, and other short-lived helper
   runs; cancellation, shutdown cleanup, process-tree termination/reaping, and
   bounded input/output/event queues are unchanged.
2. Agent session output and its persisted history keep ordinary local
   filesystem locations (workspace, target, executable, cwd, context files)
   and ambient inherited environment values (HOME, PATH, TMPDIR, SHELL, ...)
   visible instead of replacing them with `[REDACTED]`. Secrets remain
   redacted: credentials, tokens, passwords, private key blocks, sensitive
   assignment values, token shapes, and explicitly registered secret values
   (the runner request's `redactValues`; there is no production caller that
   registers run secrets). Environment delivery never implies secrecy:
   override-inherited values and the expert-shell `INTERLEAF_*` runtime values
   are ordinary local diagnostics.
   Nothing the child did not itself output is dumped.

This amendment records the residual tradeoff: redaction no longer hides local
paths or ambient environment values that a child echoes. That data stays on
the user's own machine and was never a secret channel; credential-shaped text
and designated secret values are still removed at the child boundary and
again before persistence.

## Consequences
