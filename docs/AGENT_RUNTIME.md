# Interleaf — Agent Runtime

This document describes the agent runtime that is present in the repository. It
is an implementation reference, not a promise that every installed CLI or
execution mode is available on every machine.

## Runtime boundary

The main-process modules are the source of truth:

- `src/main/agents/agent-service.ts` is the coordinator behind the IPC
  dispatcher. It keeps the public `AgentService` surface, resolves optional
  construction options into required owner dependencies once, and delegates
  to the owners below. It still owns copy result, environment actions, window
  handoff (`claimSession`), and the bounded shutdown drain. Each owner keeps
  its state private and receives its collaborators through its constructor,
  and no two owners share a mutable map.
  - `agent-service-liveness.ts`: the shutdown and persistence-closed flags,
    plus the `assertLive` / `assertAcceptingRuns` checks.
  - `agent-profile-manager.ts`: built-in and custom profiles, custom profile
    rehydration, model discovery refresh, and the custom-executable readiness
    check. `custom-profile-config.ts` builds and merges custom profile configs.
  - `agent-session-ownership.ts`: renderer owners, the per-owner operation
    token (`OwnerOperation.assertLive`), session-to-owner records, handoff
    authorization, and owner destruction.
  - `agent-run-registry.ts`: the lifecycle reservations, starting claims
    (`'start'` / `'resume'`), active runs, stop requests, owner cancellation,
    and the waits used by the handoff and shutdown drains.
  - `agent-run-events.ts` and `agent-run-consumer.ts`: event consumption for
    an active run. They persist events, redact them, push them to the
    subscribed renderer, summarize dropped events, and settle the run.
  - `agent-run-authorization.ts`: risk assessment, dangerous-run and
    direct-workspace confirmations, Codex repository trust, Native Restricted
    proofs, and the target revalidation that runs immediately before spawn.
  - `agent-session-start.ts`: `startSession` as named steps. They are plan,
    authorize, create session, then launch. Launch prepares the environment,
    persists the context packet, proves the run ready to spawn, and spawns.
    `agent-startup-rollback.ts` undoes a start that fails or is cancelled
    before it becomes active. `agent-context-packets.ts` writes context
    packets and sweeps expired ones.
  - `agent-session-resume.ts`: `resumeSession` as named steps. They are plan,
    claim, reserve lifecycle, load the persisted authority, confirm the
    workspace and danger level, prove the run ready to spawn, and spawn.
    Resume authorization is separate from start: it re-proves the persisted
    target and authority rather than resolving a new mode.

  Every await in start and resume is followed by the same re-checks. These are
  owner liveness, cancellation of the claim, and service liveness. On resume,
  the persisted target identity is re-checked too. Start does a final target
  containment revalidation immediately before the adapter is entered. The
  adapter start, claim attachment, cancellation check, and activation of the
  event consumer happen in one synchronous turn.
- `src/main/agents/agent-adapter.ts` detects built-in CLIs, assembles argv,
  and maps process events to `AgentEvent` values.
- `src/main/agents/process-runner.ts` spawns children with `shell: false`, a
  bounded stdin/stdout/stderr pipeline, and cancellation/reaping.
- `src/main/agents/mode-resolver.ts` resolves the requested mode after main
  revalidates the opaque directory handle.
- `src/main/agents/environment-manager.ts` prepares worktrees/copies, builds
  reviews, applies changes, and performs bounded recovery/cleanup.

The preload exposes only named agent operations from `src/shared/constants/ipc.ts`.
The renderer receives profile capability summaries, opaque directory handles,
session summaries, events, and review DTOs; canonical paths, executable paths,
environment values, and recovery paths stay in main.

The composer hydrates the authoritative directory projection together with the
loaded settings defaults. A valid saved handle is shown as `Profile default`;
the native Choose action is a `Per-session override`, and missing/stale handles
fall back to `Not selected`. Profile changes reset deterministically to that
profile's valid default. Late hydration, profile-list, mode-availability, and
native-picker responses cannot replace a newer profile choice or override. The
session list is scoped to the active document and renders every loaded session
for that document inside a bounded scroll region, with the selected session
exposed through `aria-current`. Main requires the document ID on list and start
operations and applies the document filter at the repository boundary; legacy
sessions without a document association are not shown.

## Model selection

Profile and model are chosen independently in the Agent panel, with the model
control stacked directly under the profile control so the effective run
configuration is readable at the point of use.

Interleaf ships no static agent-CLI model catalog (see `docs/CLI_CAPABILITIES.md`
§7.9), so availability is assembled rather than hard-coded. A profile's option
list is `resolveAgentModelOptions` in `src/shared/constants/agent-models.ts`:
the profile's configured default, then the user's bounded per-profile list in
`settings.agent.profiles[id].models` (max `MAX_AGENT_PROFILE_MODELS`), then the
identifiers the installed CLI itself reported, then a small repo-evidenced seed
table. Entries that do not match the identifier grammar — which excludes
whitespace, quotes, shell metacharacters, and leading dashes — are dropped. The
list is empty when the CLI exposes no `modelSelection` capability.

### Discovered models

`AgentModelDiscovery` (`src/main/agents/model-discovery.ts`) asks each installed
built-in CLI which models it accepts, using the per-provider listing mechanisms
recorded in `docs/CLI_CAPABILITIES.md` §7.9a. Every probe runs through
`ProcessRunner`, so a listing child gets exactly the launch path's lifecycle
rather than a second, weaker one: a fixed executable with tokenized argv,
`shell: false`, `buildMinimalChildEnvironment()`, bounded output, a bounded
lifetime, and the same TERM → KILL → group-reap sequence (`taskkill /T` on
Windows) whose completion resolves only once the process tree is proven gone.
Probes run with that runner's opt-in strict cleanup policy: when the runner
cannot prove the tree is gone — the POSIX group still present when the bounded
reap window closes, or the Windows tree helper unavailable, failed, or still
unverified after its grace — the probe's `completion` rejects, the answer is
dropped, and the provider is left with no discovered catalog for this pass
instead of one claimed from an unverified state. It
runs in a main-owned neutral directory with each CLI's project-extension loading
disabled — listing models must never execute a project's hooks, skills or config.
Probe stdout is untrusted external process output: only complete lines reach a
collector, and nothing but identifiers leaves the module; surrounding response
fields such as home directories and account state do not.

A catalog is accepted in exactly two cases. Either a collector parsed a whole
reply, in which case the probe stops the CLI deliberately and whatever exit
status that stop produces describes the stop rather than the listing; or the CLI
ended on its own with exit code 0 and no signal, in which case the trailing
unterminated line and a whole-output listing may still contribute. Anything else
contributes nothing: a spawn or timeout failure, an output-bound overrun, an
evicted event from the runner's bounded queue, a signalled exit, or a natural
non-zero exit — and a failure or cancellation reported at any point, including
after a complete reply was already collected, overrides that reply. A partial
catalog is never promoted to a successful one, and a reply read from a run whose
cleanup state is unverified is no evidence at all.

`AgentRegistry.refreshDiscoveredModels` attaches the answer to the adapter's
main-owned profile as `discoveredModels`, which is runtime-only and never
persisted. Only installed built-in profiles with `modelSelection` are probed —
never a custom executable, never the fixture, never a provider without a
declared mechanism. `AgentService` runs discovery once behind startup;
`agent:list-profiles` awaits it, so the Agent panel and Settings show the CLI's
own models without anyone typing a list, and `agent:refresh-models` re-probes on
request after a CLI is installed or upgraded. Automated app tests never
construct a discoverer, so no test depends on which CLIs a machine has.

Probes are owned, not fire-and-forget. At most one probe per provider is in
flight: a concurrent caller — including a forced refresh — joins the live one
instead of spawning a second CLI whose answer could land out of order, and
`AgentService.refreshDiscoveredModels` coalesces overlapping refresh requests
into a single listing pass. `AgentService.shutdown` cancels discovery through
`AgentRegistry.closeModelDiscovery` before draining sessions and then awaits it,
so a listing CLI and its descendants cannot outlive the service that started
them. The native-sandbox capability prober is drained the same way: closing it
withdraws Native Restricted, cancels every probe child it still owns, and awaits
their completion, so no probe outlives the drain and shutdown never waits out a
probe's own timeout for an answer nobody will use. A cancelled `verify()` answers
`null`, the ordinary fail-closed value, and writes nothing.

The tracked scope covers the whole verification, starting before its first await.
Hashing the candidate executable is itself asynchronous, so a verification
suspended there used to be invisible to `close()`, which would then resolve while
that verification went on to spawn a probe child. Every admitted attempt is
tracked from entry, and `closed` is revalidated after each suspension point and
again immediately before any spawn, so close owns every attempt and child until
it settles and no probe can start after the drain returns.

A refreshed catalog changes the same allowlist a user edit does, so it is part
of `fingerprintProfile` and invalidates an outstanding direct-workspace risk
grant exactly like an edited model list.

That one function feeds both sides of the boundary. `toRendererAgentProfile`
publishes it as `AgentProfile.availableModels`, and `AgentService.startSession`
rejects any per-run model outside it with a typed validation error before a
session row or process exists, so the renderer can only launch a combination it
was offered. Custom profiles carry no settings-persisted list and keep their
existing contract: any well-formed identifier their user-authored argv template
accepts. Accepted values reach the CLI as one whole `--model <value>` argv token
pair under `shell: false`.

The renderer keeps no competing state. `reconcileSelectedModel` in
`src/renderer/stores/use-agent-store.ts` runs on hydration, profile refresh,
profile change, explicit selection, and again at launch: a supported choice is
retained, otherwise the profile's configured default, otherwise the provider
default (`null`). The composer writes its choice back to
`settings.agent.profiles[id].defaultModel` — the same preference the Settings
editor owns — and carries the outgoing default into that profile's `models`
list so the picker never loses an option it had just offered. Editing the list
changes the profile fingerprint and therefore invalidates outstanding
direct-workspace grants.

Resume is unaffected by later UI changes: it replays the run's recorded
`effectiveModel` snapshot, never the current profile or composer default. Active
runs display their recorded profile and model in the session meta block.

Built-in profiles are detected at runtime for Codex, Claude Code, Antigravity,
OpenCode, Pi, and Cursor. GitHub Copilot is not a built-in profile; `copilot`
remains only as a legacy identifier in persisted settings and sessions, and the
adapter and service still refuse it at start as defence in depth. A missing or failed probe is represented as
`not-installed`/`error`; it does not crash the app. The fake profile is
available only in non-packaged test/development runs. Codex implements
`sessionResume: true` via `codex exec resume SESSION_ID -` with tokenized argv
and bounded stdin. Other built-in providers expose `sessionResume: false` until
their native resume contracts are implemented. Resume uses the exact persisted effective model and reasoning effort snapshot captured on session start, not current profile defaults. Custom normal profiles support configurable resume via `resumeCommandTemplate` (with `{{sessionId}}`, `{{model}}`, `{{reasoningEffort}}`), while expert custom shell profiles resume via a static `resumeShellCommand` and main-owned environment variables.
## Context packet ownership

The renderer constructs `AgentContextPacket` in
`src/renderer/stores/use-agent-store.ts` when the user submits a reader
selection. It contains a document ID/hash/title, typed anchor/location, quote,
bounded surrounding text, and an explicit untrusted-reference marker. The
renderer does not construct a path or command line.

Main validates the packet with `agentContextPacketSchema` as part of the start
request, enforces the bounded packet size, and writes the accepted JSON to:

```text
<userData>/agent-workspaces/context/<session-id>.json
```

The file is created with owner-only permissions, indexed as a session artifact,
and retained for the current seven-day cleanup window. Failed starts remove it
and its artifact row when possible. The prompt sent to a child is assembled in
main with escaped `<document><source>` and `<user-task>` values. Context files
are never written into the target repository. Agent-session events may include
bounded, redacted stdout/stderr for the session UI; durable application logs
exclude raw streams and confidential bodies.

**Renderer capture and launch ordering.** Selection, page-range, section (TOC)
and entire-document captures each take a claim of the reader identity (active
document ID and adapter) plus a capture revision and abort signal. A capture
commits atomically only if that claim still holds when it lands, on success
and on failure alike; a newer choice, a document or adapter change, or a cancel
discards it. While a capture is pending the task card shows
`Attaching <scope>…` with a Cancel control, and Start is disabled so a pending
attachment is never silently omitted. Closing the page-range dialog (Cancel,
Escape, outside click, unmount) withdraws only that dialog's own capture. The
entire-document packet carries the scope label `Entire document`.

Start validates the reader identity on entry and freezes profile, model,
directory, context and prompt before any await, so later composer edits neither
alter the launch nor are overwritten by it. Per-session attempt counters guard
action, Stop, refresh, copy, resume, error and list-reconciliation results, so a
stale result never replaces a newer attempt or a pending Stop. A Stop request
always reaches main; once its session is resumed, the earlier Stop's detail,
failure and stopping marker no longer land on the newer run. `loading`
is cleared only by the turn that set it. The follow-up draft and prompt history
are kept per session in the renderer and survive a run's transition from
running to terminal and switching between sessions.

## Modes and defaults

`auto-isolated` is the persisted/default request. Main resolves it as follows:

| Requested/resolved mode | Current behavior | Containment statement |
| --- | --- | --- |
| `auto-isolated` → `isolated-worktree` | Git target: app-owned temporary worktree and branch | Workspace isolation only; not an OS sandbox |
| `auto-isolated` → `isolated-copy` | Non-Git target: bounded app-owned directory copy | Workspace isolation only; not an OS sandbox |
| `isolated-worktree` | Requires a Git target; otherwise fails closed | Same limitation as above |
| `isolated-copy` | Explicit copy preparation | Same limitation as above |
| `native-restricted` | Direct target only after a fresh main-issued grant and an exact main-owned capability probe; currently this can prove the Codex `workspace-write` profile | Relies on the CLI's native controls; not Interleaf containment |
| `active-env` | Direct target after a fresh, single-use main-issued grant | The agent may create, modify, or delete target files |
| `container-sandbox` | Always unavailable in the current implementation | Client detection is not an executor and never triggers fallback |

Preparation failure is terminal. The runtime never silently changes an
isolated request into `active-env`. Direct modes cannot be saved as a default.
`active-env` is HIGH risk; a dangerous profile — Expert Shell or any
permission-bypass profile — is CRITICAL in every mode available today, isolated
modes included, because the level follows the authority the process holds rather
than the directory it writes to. One main-owned predicate,
`resolveAgentRiskLevel` in `src/shared/constants/agent-risk.ts`, answers for
mode resolution, the native confirmation, environment persistence, and every UI
and accessibility label, so a renderer-supplied label can never present a lower
level than main computed. The single documented exception is a future verified
container runtime, which main never asserts today because no verified container
implementation exists. The grant is bound to the sender, draft, profile
fingerprint, effective permission policy, mode, opaque directory handle, and
canonical target identity, and is consumed once.

A worktree or directory copy does not stop a process from accessing other host
resources if its CLI/profile permits that access. The current container mode is
fail-closed even when Docker/Podman is installed or its daemon is reachable:
there is no verified rootless, network-off, bounded-mount executor in this
implementation. It never falls back to direct execution.

## Protected application-data roots

A target may never overlap Interleaf's own storage. `ProtectedRootPolicy`
(`src/main/agents/protected-roots.ts`) is built in main from the userData,
database, library, AI-chat, agent-workspace, agent-context, and log roots plus
the legacy brand profile directory. Both sides are canonicalized with realpath
semantics and compared segment-wise, so the full symmetric matrix is rejected —
the candidate *is* a protected root, contains one, or lives inside one — while
distinct sibling roots such as `…/agent-workspaces` and
`…/agent-workspaces-2` are not. Symlink aliases on either side resolve to the
same tree and are rejected identically.

The check runs when a working directory is registered, again on every
`resolve()` so a persisted handle cannot survive an app-layout change, and at
the top of environment preparation — before the target lock, the session root,
and any snapshot, copy, or baseline, for isolated and direct modes alike. An
unresolvable candidate or protected root is uncertainty and fails closed.

## Workspace snapshots, manifests, and recovery

A snapshot is the record of what a target or workspace contained, and every
later decision — review, Apply, patch export, rollback, restart — is taken
against it. It is therefore produced by a bounded worker and judged entirely in
main.

**Offloaded scanning.** `src/main/agents/snapshot-worker.ts` runs the walk, the
no-follow metadata read, and the SHA-256 hashing on worker threads. The worker
may only touch a canonical root that main added to an exact-path allow-list
immediately before dispatch and revoked in a `finally` immediately after, so
the entry point is never a standing read primitive. At most two workers run at
once behind a 16-deep queue that refuses beyond it, with a ten-minute timeout,
an abort signal honoured both before and after the queue wait, settle-once
semantics that discard a late post, and a two-phase drain in
`AgentService.shutdown`. The pool is owned by the environment manager rather
than by module state, so one service's shutdown cannot silently reopen — or
permanently poison — another's. Cancellation comes from real lifecycle
operations: each session owns one `AbortController`, threaded into every
dispatch for that session and aborted by `discard` and by a failed `prepare`,
so a scan is cancelled whether it is still queued or already running. The drain
closes *admission* immediately and permanently, allows work already admitted a
bounded grace to finish the scan it needs, and then closes *dispatch*
permanently; nothing admitted afterwards, and no later owner or lifecycle work,
can start another scan for that service lifecycle. No
database handle, credential, renderer channel, or native API is reachable from
the worker. The worker source is an inline string run with
`new Worker(src, { eval: true })` — the same convention as
`src/main/workers/hash-file-worker.ts` — so packaged (asar) loading needs no
worker file on disk.

Every returned record is re-validated in main against the bounds the request
carried and then re-judged by policy: the path validator, the tracked-index
answer, the symlink rule, the entry count, and the per-file and cumulative byte
budgets. A record that fails any of these is an error, not a filtered entry.
The residual trust is narrow and worth naming: main validates the *shape and
bounds* of a hash, not its arithmetic. The hash values are trusted because the
worker source is main-authored and main-dispatched.

Responsiveness was measured rather than asserted.
`performance.eventLoopUtilization()` taken around a two-snapshot `review()`
scores 0.996 for the previous inline walk and 0.009 for the offloaded one. That
measurement is taken in the main-process runtime under Vitest; it is not a
measurement inside a packaged Electron window under real UI load.

**Manifest paths.** `src/main/agents/relative-path.ts` validates every relative
path at every manifest, recovery, and diff boundary by decomposition rather
than substring search: bounded length, no NUL or other C0 control character,
`/` as the only separator (a backslash is rejected, not normalized), no
absolute, UNC, or drive-relative prefix, and no segment that is empty,
overlong, `.`, or `..`. A *host-produced* relative path — `path.relative`
answers `packages\app` on Windows — is converted to that canonical form by
`toManifestRelativePath` before it is persisted and then validated by segment;
without that step a Windows session persisted a value its own validator rejected
and refused to rehydrate its own worktree. Translation happens only at that host
boundary, never on an untrusted record read back in. Ordinary names that merely contain `..` — `foo..bar`,
`archive..2024.tar` — stay legal. One grammar means a manifest reads the same
way on POSIX and Windows, and a snapshot can never record an entry that a
restart would silently discard.

**Tracked generated paths.** Name-based skipping of `dist`, `vendor`, `build`,
and `out` loses an agent's work on a repository that *tracks* those paths.
`src/main/agents/git-tracked-index.ts` reads `git ls-files --stage -z` once, at
preparation, bounded to 20,000 entries, and that answer is persisted as
`tracked-index.json` and rehydrated at restart. A session whose metadata records
`indexVersion: 1` and then has no readable index record fails closed rather than
being read as a legacy name-only environment; only an environment with no such
claim is read as an empty index. Ignored status is still ignored status; only
tracked entries are admitted. Freezing the answer is deliberate:
recomputing it later would let the primary repository's index drift silently
redefine what the session's baseline meant.

**Symbolic links.** A link is representable only when that frozen index says it
is tracked, and then only as metadata. The link string is read with `readlink`,
bounded at 4 KiB, refused if it is absolute or escapes the subtree, and stored
as the SHA-256 of the *link string*; the destination is never opened, in
snapshot, review, Apply, cleanup, or recovery. A tracked link under a generated
directory contributes its generated ancestors like any other tracked path, so
`dist/link.txt` keeps `dist/` listed and the link stays in the baseline. A link that is created, removed,
or repointed disables Apply in review, and `applyReserved` re-states that
refusal itself immediately before any mutation rather than trusting a review
computed earlier. Non-Git trees reject every symbolic link outright.

**Preparation journal.** `src/main/agents/preparation-journal.ts` writes
`preparation.json` for every currently supported mode through an
`fsync`-then-`rename` of a temp file, naming the phase reached and a UUID
`ownerId` bound to that session root path, and commits only once the manifest
and metadata are durable and workspace registration is complete. `manifest.json`
and `tracked-index.json` are themselves written, fsynced and renamed — with
their parent directory fsynced — before the journal phase that claims them, so a
journal can never outrun the record it reports.

A UUID living inside the session root proves nothing: that subtree is where an
agent runs. Ownership is decided by `src/main/agents/preparation-owner.ts` — one
main-created marker minted per installation and held *outside* the agent
environment root, holding an installation id and a random secret, opened
`O_NOFOLLOW` and proved to be a private, app-owned regular file before a byte of
it is believed. Each journal carries an HMAC-SHA256 over its own canonical
fields, and reconciliation recomputes it with `timingSafeEqual`. Startup
therefore removes exactly one thing: an uncommitted journal whose MAC verifies
against this installation's marker and which names this exact session root. A
missing journal, a corrupt one, one naming a different session root, one
carrying a foreign or forged installation id or MAC, or a root whose external
Git registration has not yet been unwound is left on disk for explicit repair —
never widened into a deletion target. A `pending-git-cleanup.json` that is
malformed or unreadable is distinguished from an absent one and retains both the
root and the external registration.

This is not an OS isolation boundary, and is not claimed as one: a process
running as the same user with unrestricted filesystem reach can read the marker.
What it removes is forgery through renderer-, workspace- or model-writable
data — the paths an agent actually writes through. `container-sandbox` is fail-closed and has no executor, so it
has no preparation to journal.

One window the owner marker cannot cover is stated rather than hidden: between
creating a session root and renaming its first journal into place, the
directory holds nothing but, at most, the journal's own `O_EXCL` temp file. A
session root that is empty apart from that temp is treated as an abandoned
preparation of ours — it has no manifest, no metadata, no workspace, and no
user data to lose. A root holding anything else is not covered by that rule and
falls back to the journal check, which fails closed.

**Recovery backups.** One `BackupBudget` spans a whole apply transaction — 64
MiB per file, 512 MiB cumulative, 100,000 entries, depth 64, 20,000 children
per directory — charged by every backup copy in it, so many individually
reasonable backups cannot collectively exhaust the disk. A budget is
consumptive, so validation and restoration are separate passes with their own:
charging all three to one allowance made a legitimate restore of anything past a
third of the cumulative limit fail *after* the target had been removed. Each file is opened `O_NOFOLLOW` and `fstat`ed
before and after its bounded chunked copy, so growth, replacement, or an
ownership change inside that window fails closed instead of being recorded as
the backup, and chunked writes loop on `bytesWritten` rather than leaving the
only copy of the user's data short. Rollback proves the *complete* restore set
before removing the first target it replaces, and proving it means reading every
backup byte — an `lstat` and a successful `open` say nothing about a truncated
file or an I/O error mid-extent. The earlier ordering could destroy the target
and only then discover the backup was unusable. Nothing outside the owned recovery root is
deleted, and an entry that cannot be proven is preserved rather than guessed
at.

## Persisted session identity and authority

Every new session durably records two main-owned snapshots (additive migration
24; migrations 1–23 are untouched):

- `target_identity_json`: the opaque directory handle plus the exact canonical
  path and file identity (device, inode, birth time; `docs/SECURITY.md`) the
  session was authorised against. The environment journal records the same.
- `authority_json`: the main-resolved profile id and fingerprint, effective
  permission policy, execution mode, unsafe flag, exact resume sandbox argv,
  reasoning effort, and the native-capability proof (contract id and executable
  fingerprint).

Rehydrate, review, apply, open-folder, and resume all revalidate the *persisted*
identity; the current registry entry is never substituted for it. A changed
canonical path or file identity — including an identical-content directory
recreated at the same path on a reused inode — fails closed without altering the
prior terminal session or its target. Resume enforces the persisted policy, not
current profile defaults, binds direct and native grants to it, and rejects
direct-mode profile or policy drift before any adapter spawn. A session whose
snapshot is missing, unparseable, or predates birth time (migration 26) cannot
be continued, and an environment journal without a provable file identity is
equally unusable: startup recovery leaves such a directory untouched for a later
explicit repair rather than re-admitting it as a resumable environment.

`fingerprintExecutionAuthority` (`src/main/agents/execution-authority.ts`) is the
single derivation behind the words "profile fingerprint": risk-grant issuance,
the persisted authority snapshot, and the resume drift check all read it, so no
field can be accepted by one and rejected by another. It covers every main-only
value that decides what would be executed — the durable executable identity
including its content SHA-256, execution kind and shell family, start and resume
argv templates and shell commands, prompt delivery, working-directory policy,
prompt root, environment policy and overrides, the unsafe flag, and the
permission, sandbox, model, and reasoning configuration — under a stable
key-sorted serialization. Every included field is also durable across an
application restart, because an unchanged session must remain resumable after a
relaunch. Excluded for that reason, none of them able to change what runs:
display-only detection state (availability, reported version, `checkedAt`), which
changes on every background re-detection; the profile's display name; the opaque
`executableHandle`, a process-local capability token reissued by
`ExecutableRegistry.rehydrate()` on every launch, the executable being bound
instead by canonical path plus durable identity including the content digest; and
`discoveredModels`, the runtime-only CLI listing probe result that is never
persisted, where the executed model is the persisted effective model and a new
run's model is validated against the allowlist at launch.

### Target rechecks and the residual race

Identity is proven again after *every* unbounded await, not once per operation.
On start and on resume the registered directory is re-resolved — which re-applies
the protected-root policy and the registry's own file-identity revalidation — and
re-checked against the persisted canonical path and file identity immediately
before `adapter.start`/`adapter.resume`, after the confirmation dialogs, the
executable integrity check, the Git-trust probe, and the final uncached
capability proof. `applyReserved` does the same: the entry check is repeated
after the review, the Git inspections, and both directory snapshots, immediately
before the apply journal, staging directory, or any target write exists. Order
matters there: the protected-root policy canonicalizes its candidate and then
awaits canonicalization of each configured root, so it is itself a window, and
the persisted file-identity proof therefore runs last, with no await between it
and the first byte of mutation state.

This removes the long app-created windows. It does not remove the narrow
syscall-level race between the last check and the operation itself: a same-user
process can still act in that interval, and no user-space check can close it.
That residual is bounded by what follows it — per-entry symlink, ancestor, and
expected-entry checks during apply, and `shell: false` spawns with a fixed
executable and tokenized argv — and is stated here rather than claimed away.

### Resume never overwrites a terminal attempt

A rejected resume is not a new attempt. Nothing is persisted until every
pre-spawn check has passed *and* `adapter.resume()` has returned a live run
handle: the session keeps its exact terminal status and final report, and gains
no `running` transition, no run-generation change, and no error event that would
misattribute the rejection to the completed run. If the adapter throws before
returning a handle, the prior session is likewise untouched; if a returned handle
cannot be recorded, it is cancelled rather than left running behind a session
that never advanced.

Stopping a resume before that point behaves the same way. A claimed-but-not-live
resume is distinguished from a fresh start, so `stopSession` only raises an
in-memory cancellation flag instead of writing `cancelled` over the previous
attempt's terminal status, final report, and event history. The resume path reads
that flag again immediately before calling the adapter and returns without
spawning or persisting anything. Once a live resumed handle exists, ordinary
cancellation semantics apply unchanged.

## Native Restricted capability proof

Native Restricted is granted only against an actual bounded proof, never a
capability bit or an argv glance. For a statically eligible built-in profile —
installed, not custom, not unsafe, no permission-bypass mode, and already
carrying the contract's exact start argv — main fingerprints the canonical
executable (realpath, regular file, executable bit, bounded size, plus device,
inode, size, and a bounded SHA-256 digest of its contents computed by the same
no-follow hash worker the executable registry uses, so a replacement that
preserves inode, size, and mtime is still a different executable), then runs `--version`, `codex exec --help`, and
`codex exec resume --help` with a fixed executable, tokenized argv,
`shell: false`, a minimal environment, bounded output and time, and strict
child-tree cleanup, in an app-owned empty directory. That output is untrusted
text and is only searched for the exact tokens of one fixed contract. The
fingerprint is re-read afterwards, and the verified result is bound to it and to
the contract's exact start and resume argv.

`codex exec resume` has no `--sandbox` selector, so the sandbox chosen at start
is carried on resume by the tokenized `-c sandbox_mode="workspace-write"`
override. That exact key is evidenced by `codex --help`'s documented
`sandbox_mode` config; the generic `-c key=value` form is evidenced, but no
particular *effort* key is, which is why Codex effort is unavailable (below).
The
contract explicitly forbids a resume-side `--sandbox` token, so a future release
that adds one is treated as drift and re-verified deliberately. The adapter
accepts only the exact approved sandbox override tokens.

The proof is re-run, uncached, immediately before `adapter.start` and
`adapter.resume` — after every confirmation dialog, environment preparation,
and other unbounded await — and the result must still match the exact
executable and argv contract the session was authorized under. The proof is
itself a multi-second await, so the target identity is re-checked once more
after it returns and before the adapter is entered. Mode-availability
listings may answer from a short-lived identity-keyed cache; start and resume
authorization never do. Version drift,
help-output drift, binary replacement, timeout, truncation, a non-zero exit,
malformed output, or any other uncertainty makes Native Restricted unavailable
before an adapter is spawned. No inference or task run is ever used as a probe.

`antigravity` declares `nativeSandbox: true`, but its argv preset carries no
sandbox selector and `agy --help` exposes no enforceable native-sandbox flag, so
Interleaf cannot truthfully prove containment for it. Native Restricted stays
unavailable for that adapter rather than falling back to active-env or isolated
execution. The same applies to every custom, Expert Shell, unsafe, and fixture
profile.

## Overlapping targets and lifecycle serialization

`AgentEnvironmentManager` keeps an in-memory lock for each prepared target
scope. Preparation rejects overlapping scopes, including a directory and its
child; a Git session locks the repository root. Therefore independent,
non-overlapping targets may execute concurrently, but sessions that overlap
cannot both be prepared. The lock remains until the environment is discarded,
released, or startup recovery resolves it. Apply/discard operations also
revalidate and hold the target lock; they are not an invitation to run two
overlapping agents concurrently.

Each isolated environment records an immutable baseline manifest of path,
type, mode, size, and hash. Git worktrees capture repository identity, base
HEAD, and whether the primary was dirty. Directory copies reject symlinks that
escape the copy boundary. Review output is bounded and includes changed files,
diff availability, and agent-reported test results. The test inventory is bounded
per run, not per session: each start or resume reopens a budget of 128 admitted
results, so a resumed session keeps reporting while no single run can flood.

Admission happens before any per-result work. `admitTestResult` is a synchronous
decision taken ahead of event persistence, subscriber delivery, artifact
creation, and review passes, so a refused result costs no database write, no
broadcast, no workspace scan, and no metadata rewrite — the previous ordering
made a flood more expensive, not less. Refused results are coalesced into one
deterministic summary entry per run, and the inventory is flushed to
`environment.json` once, when a run's results settle, rather than once per
refused frame. Durable history stays bounded independently at 512 retained
entries, oldest first. The events themselves, including the terminal `final` and
`ended` events, are still persisted and delivered in order; only the per-result
fan-out is bounded, and the coalesced summary is emitted once at the terminal
transition. The suppressed count survives restarts so a session that flooded
keeps one truthful total.

Startup retention does not treat age as abandonment. A prepared environment
whose journal validates and whose manifest is readable but unapplied is the only
copy of the agent's work, so it is retained past the abandonment bound and
rehydrated as reviewable in both isolated-copy and Git worktree modes. The age
bound still governs environments whose work was already applied and entries with
no readable manifest; corrupt or unknown entries are left untouched on disk
rather than recursively removed.

Apply is available only after the persisted session is terminal and the child
consumer has reaped the process. It revalidates target identity, repository
HEAD/cleanliness, manifests, symlinks, and collisions. Directory-copy apply
uses an app-owned staging/recovery journal and rolls back on failure. Git
apply is blocked for a dirty primary. Export is unavailable for binary or
oversized copy changes. Dismissing the save dialog is not a failure: patch
export returns a typed `{ outcome: 'cancelled' }` result through preload to the
renderer, which shows a neutral "Nothing was saved" notice rather than an
error; no caller matches error-message text. Direct-mode discard removes only Interleaf's baseline
and session metadata; it does not undo changes already made in the target.
The renderer asks first: Discard Sandbox opens an `alertdialog` above the
whole window that names the run, its workspace and its mode, says which of
those two outcomes applies and that the run cannot be resumed, and focuses
Cancel. While it is open the rest of the window (the wide shell, or the
compact drawer and its controls) is inert, focus sent behind it returns to
it, and it keeps Tab and Escape to itself, so the drawer stays open behind
it. Only its confirm button reaches main, once. The dialog freezes the run,
book and store run attempt (bumped the moment a resume begins) and the exact
review — workspace, mode, diff and changed files — it was opened on, and
withdraws when any of them changes. Withdrawal is only the visible half: the
store compares that frozen origin with its own current state synchronously,
immediately before calling main, and refuses — with no main call — unless the
run, book and attempt still match, the run is still stopped with an
undiscarded environment, and the review is exactly the one confirmed, so an
old Confirm clicked before React re-renders cannot discard anything else.
Main's own lifecycle and ownership checks still apply after that. Once main has
discarded, the store marks that run's environment discarded at once, so the
review, apply, export, open-folder and resume actions go even if reloading
the run then fails; that failure is shown as "Sandbox discarded, but this run
could not be reloaded", never as a failed discard. Focus then moves to the
run's New task button, unless it has already moved elsewhere; if another run
was opened meanwhile, focus is not returned to the old run's controls.
Failed Git cleanup leaves a bounded pending record for startup retry; unknown
or corrupt records are not recursively removed.

## Process and profile safety

Normal child execution uses tokenized `argv: string[]`, `shell: false`, an
allowlisted environment, bounded stdin, and bounded output/event queues. A
user-started agent run has no total wall-clock deadline: it stays alive until
the child exits, the user cancels, or Interleaf shuts down. Only bounded
short-lived probes, helper runs, and tests pass an explicit finite timeout to
`ProcessRunner`, which enforces exactly that value. Cancellation sends
termination to the process group on POSIX and escalates. On Windows it invokes
the trusted absolute `%SystemRoot%\System32\taskkill.exe` with `/PID <digits> /T`,
then `/F` after a bounded grace period; a failed or unavailable tree helper
leaves completion fail-closed because direct-child exit does not prove
descendant termination. The run's completion promise waits for the cleanup
contract. Profiles may use stdin or a bounded positional prompt, but prompts
and filenames are never interpolated into a shell command.

Built-in argv is evidence-bound. `REASONING_EFFORT_ARGV` in
`src/main/agents/agent-adapter.ts` holds only the reasoning-effort forms this
repository has evidence for in `docs/CLI_CAPABILITIES.md` — `--effort` for
Claude Code and Antigravity, and `--variant` for OpenCode. A provider with no
proven form refuses the run rather than falling through silently, which
previously ran the agent at the CLI's default effort while the UI still showed
the effort the user picked.

Codex is one of those providers. This repository evidences that Codex accepts
generic `-c key=value` overrides; it does **not** evidence that
`model_reasoning_effort` is the key Codex reads for effort, and an unrecognized
key would be accepted and silently ignored — the same mismatch, one layer down.
Codex's `reasoningSelection` capability is therefore `false`, its profile editor
offers only the provider default, and a start or resume that still carries an
effort is refused before any spawn. Restoring the selector requires empirically
verifying the exact key against an installed Codex, then updating
`docs/CLI_CAPABILITIES.md` §3 and the adapter together. `tests/unit/agent-provider-contracts.spec.ts` pins
the exact start and resume argv for every currently supported built-in and
asserts that each fail-closed refusal spawns no process.

Pi's Agent Mode contract was the one built-in claim with no evidence behind it
(item O). It is now decided and verified against the installed pi 0.84.4
sources, and the exact argv, prompt-delivery and risk contract is recorded in
`docs/CLI_CAPABILITIES.md` §5.1. Two parts of that decision matter here:

- **Pi is enabled, and permanently unsafe.** `--print --mode json` is a genuine
  unattended mode, but Pi ships no sandbox and no approval system of any kind,
  so a tool-enabled run is unmediated by construction. `pi` is therefore listed
  in `ALWAYS_UNSAFE_AGENT_PROVIDERS`, which is re-asserted both when the profile
  is built from its definition and when a settings apply rebuilds it. The
  profile's `unsafe` flag is what makes every Pi run `critical` risk: a fresh
  bound native confirmation on each start, a dangerous-profile environment, and
  a static refusal of Native Restricted in `native-sandbox-probe.ts`. No
  permission mode offered in settings can downgrade this, and Pi is never
  presented as approval-respecting.
- **Only evidenced capabilities are claimed.** `structuredOutput`, `toolEvents`
  and `reasoningSelection` (`--thinking`) are on; `nativeSandbox`,
  `sessionResume` and `fileChangeEvents` stay off. Pi's events carry no
  `changed-files` discriminator, and its JSON mode exits 0 even on an errored
  turn, so nothing in the raw stream reports the outcome or the answer.
  `src/main/agents/pi-stream.ts` sits between `ProcessRunner` and
  `mapProcessEvents` — reading only frames the runner has already bounded and
  redacted — and translates Pi's own shapes into the runtime's existing ones: an
  assistant message becomes `assistant_message`, a tool call becomes
  `command_execution`, `stopReason: "error"` becomes a typed process error,
  `"aborted"` becomes a cancellation, and the authoritative message text becomes
  one `final` event. Only the latest assistant message may become that report:
  each new message clears the earlier candidate, and the latest must be a
  completed terminal `stop` with non-empty, in-bound text. An empty, over-bound,
  unfinished, or `toolUse`/`length`/`deferred`/unknown-stop last message leaves
  no report rather than an earlier one. The report is also withheld, never
  truncated, on a dropped-frame summary, a bound overrun, an error, a
  cancellation, a non-zero exit, or a signal. Verified against recorded
  fixtures only, not a live Pi run. The prompt travels on stdin because Pi's parser would otherwise read a
  `@`-leading prompt as a file include.
- **Pi's argv is checked at two boundaries, because shape is not authority.**
  `assertPiStoredArgv` requires `profile.defaultArgs` — where a settings apply
  lands — to equal the preset exactly, before the adapter appends anything.
  `assertPiUnattendedArgv` then requires the effective argv to be that preset
  followed only by Interleaf's own `--model`/`--thinking` tokens with
  re-validated values. The effective check alone could not tell a
  settings-supplied `--model <valid-id>` from an app-appended one, and since the
  app appends a model only when `request.model ?? profile.defaultModel` is
  non-null, a stored pair reached Pi unchanged while `AgentService` validated
  and recorded the null effective model — task and document context to a model
  the app never selected. A dropped or reordered preset token, a positional, an
  overriding flag (`--mode text`, `--extension`, a second `--print`),
  `--approve`/`-a`, and any settings-supplied model or thinking pair are all
  refused without spawning.

The runtime supports custom profiles through the main/preload IPC methods
`selectExecutable`, `listCustomProfiles`, `createCustomProfile`,
`updateCustomProfile`, and `deleteCustomProfile`. Main validates the selected
regular executable, records its device/inode/birth-time/size/mtime/SHA-256 identity, and
revalidates it before a run. Custom profiles are discriminated by `executionKind`:

1. **Normal Custom Profiles (`executionKind: 'normal'`)**: Strict tokenized argv
   templates, `shell: false`, and no command strings. Placeholders are limited
   to whole tokens: `{{workingDir}}`, `{{promptFile}}`, `{{sessionId}}`,
   `{{model}}`, and `{{reasoningEffort}}`. Normal mode rejects shell-only
   configuration, direct shell binaries (`sh`, `bash`, `zsh`, `pwsh`, `cmd`,
   etc.), and direct shell eval flags (`-c`, `/c`, `-Command`). Prompts can be
   delivered via `stdin` or private `temp-file`.

2. **Expert Shell Profiles (`executionKind: 'expert-shell'`)**: Separate dangerous
   path for advanced power users. Selects a validated shell executable (`posix`,
   `powershell`, `cmd`) validated against platform allowlists and executed with
   fixed tokenized family arguments (`-lc COMMAND`, `-NoProfile -NonInteractive -Command COMMAND`,
   `/d /s /c COMMAND`) with Node `shell: false`. Bounded static commands and
   optional static resume commands are stored as user configuration; user
   prompts, document text, and filesystem paths are never interpolated into a
   command string. Prompt delivery is strictly `stdin`. Main-owned bounded
   values are exposed via a minimal child environment: `INTERLEAF_SESSION_ID`,
   `INTERLEAF_RUN_ID`, `INTERLEAF_MODEL`, `INTERLEAF_REASONING_EFFORT`, and
   `INTERLEAF_WORKING_DIR`. Those runtime values are ordinary local
   diagnostics: if the child prints them they stay visible, while actual
   credential-shaped output still redacts.

A text-mode profile — custom or Expert Shell with `stdoutParsingMode: 'text'` —
emits no JSON final frame, so its run would otherwise persist no report and
leave Copy with nothing to offer. Its already-redacted stdout is collected under
a 64 KiB bound and synthesized into one `final` event immediately before `ended`,
and only on a clean zero exit with no signal. Anything that makes the text
untrustworthy or incomplete — an error, the runtime output cap, cancellation,
the quarantine marker, a non-zero or signalled exit, or output past the bound —
withholds the report rather than truncating it. A runner queue-loss marker counts
as incompleteness too: when `ProcessRunner` drops frames to stay within its
bound it emits a structured `dropped-events` summary, and the mapper withholds
synthesis on it, because a report synthesized from what survived would present a
gap as the whole answer. Copy then has nothing to offer for that run, which is
the honest outcome. `json-lines` and `none` profiles are unaffected.

## Process runner and output redaction

`ProcessRunner` uses `spawn(file, argv, { shell: false })`, closes stdin when
appropriate, bounds input/output/event sizes, enforces explicit finite
timeouts where callers request them, and escalates process-group termination
on POSIX. User agent runs carry no total deadline. Child environments are
constructed from an allowlist; parent `process.env` and Interleaf secrets are
not copied wholesale. Agent output is redacted at the child boundary and again
before persistence or renderer delivery. Redaction targets only explicitly
registered secret values (the runner request's `redactValues`; there is no
production caller that registers run secrets) plus credential shapes: private
key blocks, bearer headers, token shapes, and secret assignments. Environment
delivery never implies secrecy: per-run override values and the expert-shell
`INTERLEAF_*` metadata are ordinary local diagnostics, as are ambient
inherited values. Ordinary local filesystem locations (workspace, target,
executable, cwd, context files) and ambient inherited environment values
(HOME, PATH, TMPDIR, SHELL, ...) are deliberately not redacted so users keep
readable command and error diagnostics from their own machine.

Expert mode requires a dedicated native warning on creation/transition and a
fresh native confirmation on every start and resume (critical risk level).
Declining creates no session, environment, prompt file, or process. Direct
workspace modes (`active-env`, `native-restricted`) still require their
separately bound risk grant confirmation.

## Copy result

Copy Result is main-owned through an injected Electron clipboard seam
(`agent.copyResult` IPC channel). The renderer passes only the session ID. Main
validates ownership, ensures the session is in a terminal state, redacts the
final report, checks bounded character length (<= 65,536 characters), writes to
the system clipboard, and returns a typed `{ copied: true, characterCount }`
acknowledgement. Navigator clipboard access is prohibited for this action.

Terminal status alone is not the barrier. `stopSession` records `cancelled`
before the child is reaped, and a claimed resume leaves the previous attempt's
completed record in place until the new run persists anything, so in both
windows the report on record belongs to a generation the session has already
left. Copy is refused with one documented barrier error while a run is active or
starting, and the per-session run generation is re-checked after the report is
read — its only suspension point — so what reaches the clipboard is always one
stable terminal generation rather than a stale report.

## Session ownership and window handoff

A session belongs to the window that started it. Main records `{ ownerId,
released }` per session and never infers ownership from a renderer-supplied
session ID: a window that holds no live ownership record is rejected for every
owner-bound action. When a `webContents` is destroyed, main cancels that owner's
runs, drains its pending operations, and only then marks its sessions released —
the record still names the dead owner, so nothing is adopted implicitly.

Authority to take over is minted by main, never by the caller. Main's own window
factory is the only caller of `adoptMainWindow`, and it names the `webContents`
it just created as the app's main window. Adoption — and the destruction of an
owner while a main window already exists — is what mints a per-session handoff
grant bound to both the dead owner and that one authorized successor. A grant is
revoked when its successor window is itself destroyed and is spent on transfer.
`agent:claim-session` therefore carries no authority of its own: it is the
renderer asking main to spend a grant main already issued. A window that names a
session ID without a matching grant — an unrelated live window, or any renderer
guessing at IDs — is refused, and no caller-supplied owner identity or window
label is ever trusted. After a restart no ownership record exists in memory; the
adopted main window, and only it, recovers persisted sessions through that same
trusted binding.

The claim is itself a pending owner operation. It is registered before it awaits,
invalidated if the claimant's window dies mid-drain, and re-authorized against
live ownership and claimant liveness after every await, so a destroyed claimant
can never be installed as owner and a later legitimate window can still claim the
session. The drain covers the released owner's pending operations, session
consumer, and lifecycle reservation, and deliberately excludes the claimant's own
pending operations so the claim cannot wait on itself. A claim is refused while
the session is active or starting or persisted as `running`/`queued`/`waiting`.
Only then does ownership transfer, and the new owner is subscribed to the
session's events as part of the same handoff. This is what makes the macOS
close-and-reopen path work: closing the last window does not quit the app, so the
window that reopens is a different owner, is adopted by main's factory, and
claims the session before it can review, copy, resume, or act on it.

Ownership is also re-checked after suspension points, not only at entry. Copy
re-asserts the caller's ownership both after its first await and immediately
before it writes the clipboard, so a caller invalidated while the report was
being read cannot produce a privileged side effect.

## Operational evidence

Relevant tests include `tests/unit/agent-run-lifetime.spec.ts`,
`tests/unit/agent-runtime.spec.ts`,
`tests/unit/agent-environment.spec.ts`,
`tests/unit/agent-service.spec.ts`,
`tests/unit/working-directory-registry.spec.ts`,
`tests/unit/working-directory-capabilities.spec.ts`,
`tests/unit/cross-event-redaction.spec.ts`,
`tests/unit/agent-resume-copy.spec.ts`,
`tests/unit/agent-rehydration-codex-resume.spec.ts`,
`tests/unit/agent-session-effective-resume.spec.ts`,
`tests/unit/agent-model-selection.spec.ts`,
`tests/unit/expert-shell-profile.spec.ts`,
`tests/integration/agent-repository.spec.ts`,
`tests/integration/agent-environment-workflow.spec.ts`,
`tests/integration/expert-shell-execution.spec.ts`,
`tests/renderer/agent-composer.spec.tsx`,
`tests/renderer/agent-store.spec.ts`,
`tests/renderer/agent-working-directories-settings.spec.tsx`,
`tests/renderer/custom-agent-profiles.spec.tsx`,
`tests/renderer/agent-model-selection.spec.tsx`, and the agent workflow rows in
`tests/e2e/workflows.spec.ts` and `tests/e2e/agent-model-selection.spec.ts`.
These tests use the fake executable or bounded shell fixtures and do not require
paid provider tokens. Counts are re-measured by the suite itself; run
`npm run lint`, `npm run typecheck`, `npm run test`, and the Playwright E2E
project for the current totals.
