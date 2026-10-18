# CLI Capabilities — Evidence-Based Reference

**Inspection date:** 2026-08-23
**Host:** macOS Darwin 25.5.0, arm64 (Apple M4 Pro)
**Method:** Non-destructive inspection only. Every behavioral claim below comes from `--help`/subcommand-help output of the *locally installed* binaries, or from the exact read-only commands listed in Appendix A. **No model prompts were run, no authentication was performed, no settings were mutated.** Event/JSON payload schemas are intentionally *not* asserted from memory; see §7 Runtime Probes.

---

## 1. Inventory

| CLI | Resolved path | Installed version | Drift note |
|---|---|---|---|
| `codex` | `~/.local/bin/codex` | `codex-cli 0.149.1` | Now `0.154.0` on this host (2026-09-09). Capability claims below were not re-inspected; only §7.9a and the `login status` output shape were. |
| `claude` | `~/.local/bin/claude` | `2.1.210 (Claude Code)` | Now `2.1.267` on this host (2026-09-09). Same caveat as codex; the print-mode guard in §4 was confirmed on 2.1.267 by a parse-only `--help` probe and by reading the guard string in the installed binary. |
| `agy` (Antigravity) | `~/.local/bin/agy` | `1.1.13` | `agy changelog` reports upstream latest `1.1.19`; installed was older. Now `1.1.27` on this host (2026-09-08). Re-probe after upgrade. |
| `copilot` (GitHub Copilot CLI) | `/opt/homebrew/bin/copilot` | `GitHub Copilot CLI 0.0.410` | Upstream offers `1.0.80` — a **major** version gap. Capabilities below describe 0.0.410 only; expect material changes after upgrade. Still `0.0.410` on 2026-09-08. |
| `opencode` | `/opt/homebrew/bin/opencode` | `1.14.18` | Now `1.18.23` on this host (2026-09-08). |
| `pi` | — | **Not installed** at 2026-08-23 | **Now installed**: `~/.nvm/versions/node/<version>/bin/pi`, `0.84.4` (2026-09-08). Its model listing (§7.9a), its `--help`/`auth check --help` surface, and its documented JSON event schema (`docs/json.md` in the installed package) were inspected read-only; §3, §5 and §6 still describe the not-installed state. The Reader Chat adapter in §4 depends on the flags listed there and fails closed — not installed, no listing, or no ready model provider all yield an unavailable provider rather than a fallback invocation. |
| `omp` (Oh My Pi) | `~/.bun/bin/omp` | `omp/18.1.16` | Installed and inspected read-only on 2026-09-10 (`--version`, `--help`, `models --json --no-extensions`). Pi's successor: same structured JSON event schema, different flag surface — notably **no `--offline` flag**. Reader Chat only; no Agent Mode execution profile. Its catalog is large (589 entries across providers on this host), so main bounds and round-robins it rather than exposing it whole. |
| `cursor-agent` (Cursor) | — | **Not installed**, and **never probed** | ⚠ **The one exception to this document's method.** Interleaf ships a Cursor Agent Mode profile whose binary name, argv preset (`--print --output-format stream-json`), `--version` probe and `--model` flag were taken from Cursor's published CLI documentation, by an explicit supervisor decision, *without* installing or running `cursor-agent`. Nothing about Cursor in this repository is observed behaviour. Its capability table is conservative for that reason: `sessionResume`, `toolEvents`, `fileChangeEvents`, `reasoningSelection`, `subagents` and `nativeSandbox` are all false, it has no `NATIVE_SANDBOX_CONTRACTS` entry, no model-listing probe, no seeded models, and no approval-bypassing preset (documented `--force` is deliberately excluded). Reader Chat is registered but permanently unavailable. Install and probe the binary before upgrading any of these claims. |
| `docker` | `/opt/homebrew/bin/docker` | Client `29.2.1, build a5c7197d72` | **Daemon not running** at inspection time (`colima` context socket `~/.colima/default/docker.sock` absent). Container sandbox availability is a runtime fact, never a build-time assumption. |
| `podman` | — | **Not installed** | Same treatment as `pi`. |
| `git` | `/usr/bin/git` | `2.50.1` | Worktree engine dependency. |

---

## 2. Workspace Mode Statement (read this before using §5)

**Isolated Worktree (`isolated-worktree`) is Interleaf's default workspace mode for Git repositories; Isolated Directory Copy (`isolated-copy`) is the equivalent default for non-Git directories. Direct execution in the active environment (`active-env`) requires deliberate explicit user selection with elevated visual risk indicators.**

This Interleaf-side isolation is **independent of every CLI's native sandbox**:

- A CLI's sandbox/permission flags (e.g. `codex -s`, `claude --permission-mode`, `agy --sandbox`, `copilot --allow-all-paths`) are **vendor-provided defense-in-depth layers**, orthogonal to which directory Interleaf spawns the process in.
- Conversely, spawning inside a Interleaf worktree does **not** constrain a CLI that was launched with a bypass/dangerous flag — such a process can still touch anything the OS user can touch. Dangerous profiles therefore require either a stronger external sandbox (container) or explicit user risk confirmation, per `docs/SECURITY.md`.
- The two layers compose: Interleaf picks *where* the process runs; the CLI profile picks *what the model's tool calls may do*. Never present one as a substitute for the other.

**Native Restricted requires proof, not a capability bit.** Main runs a bounded,
non-inference `--version` + `--help` probe bound to the canonical executable's
content-hash fingerprint and to one fixed argv contract, re-run uncached
immediately before every start and every resume (see [Agent Runtime](AGENT_RUNTIME.md) §"Native Restricted
capability proof"). Only `codex` currently has a provable contract
(`exec --json --sandbox workspace-write` at start, `-c sandbox_mode="workspace-write"`
on resume, because `codex exec resume` has no `--sandbox` selector of its own).
`agy` reports `--sandbox` as "terminal restrictions" with no enforceable
native-sandbox contract in its help output, so Native Restricted stays
**unavailable** for Antigravity rather than silently degrading to active-env or
isolated execution. The same applies to every other adapter in this matrix.

---

## 3. Capability Matrix (observed, per installed version)

Legend: ✔ first-class flag observed in help · ◐ partial / indirect · ✘ not available · ❓ exists but shape unverifiable without a paid run (see §7)

| Capability | codex 0.149.1 | claude 2.1.210 | agy 1.1.13 | copilot 0.0.410 | opencode 1.14.18 |
|---|---|---|---|---|---|
| Non-interactive mode | ✔ `codex exec [PROMPT]` (alias `e`); prompt arg, `-`, or piped stdin | ✔ `-p/--print` | ✔ `--print` / `--prompt` / `-p`; `--print-timeout` (default 5m) | ✘ unavailable for unattended Agent Mode (requires broad `--allow-all-tools`) | ✔ `opencode run [message..]` |
| Structured output | ✔ `exec --json` (JSONL events); `--output-schema <FILE>` constrains final response; `-o/--output-last-message <FILE>` | ✔ `--output-format text\|json\|stream-json`; `--input-format stream-json`; `--include-partial-messages`; `--include-hook-events`; `--json-schema <schema>` | ✔ `--output-format text\|json\|stream-json`; `--json-schema` (string or file) | ✘ no JSON format flag; closest is `-s/--silent` (response-only text) | ✔ `run --format json` (“raw JSON events”) |
| Session resume | ✔ `exec resume [SESSION_ID] [--last]`; also `fork`, `queue`, `archive` | ✔ `-r/--resume [id]`, `-c/--continue`, `--session-id <uuid>`, `--fork-session` | ✔ `--conversation <ID>`, `-c/--continue` | ✔ `--resume [sessionId]`, `--continue` | ✔ `-s/--session <id>`, `-c/--continue`, `--fork` |
| Native OS sandbox | ✔ `-s read-only\|workspace-write\|danger-full-access`; standalone `codex sandbox` command runner (macOS Seatbelt); approval policies `on-request\|never`; `--add-dir` extra writable roots | ◐ no OS sandbox; permission *modes* gate tools: `acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan`; `--allowedTools/--disallowedTools`; `--tools ""` disables all tools | ◐ `--sandbox` (“terminal restrictions”); `--mode accept-edits\|plan`; `--add-dir` | ◐ no OS sandbox; tool/path/URL allow-deny lists (`--allow-tool`, `--deny-tool`, `--allow-all-paths`, `--allow-url`, `--deny-url`) | ◐ no sandbox flag; `--dangerously-skip-permissions` auto-approves everything else |
| Working directory | ✔ `-C/--cd <DIR>` | ◐ inherits spawn cwd; `--add-dir` extends access | ◐ inherits spawn cwd; `--add-dir` (repeatable) | ◐ inherits spawn cwd; `--add-dir` (repeatable) | ✔ `run --dir <DIR>` (also remote path when attaching) |
| Model selection | ✔ `-m/--model <MODEL>` | ✔ `--model` (alias or full name) | ✔ `--model`; catalog via `agy models` | ✔ `--model` with fixed choices (claude/gemini/gpt families) | ✔ `-m provider/model` |
| Reasoning effort | ◐ **Reader Chat only.** No first-class flag; Codex 0.162.1's own config schema documents `model_reasoning_effort`, and `app-server` `model/list` publishes each model's `supportedReasoningEfforts` (read-only discovery, no model prompts). Reader Chat sends `-c model_reasoning_effort="X"` only for a level the listing offered that model (never `ultra`). Whether the turn honoured it is unverified without a paid run. **Agent Mode is unchanged and still fails closed:** `reasoningSelection: false`, provider default only, and a start/resume carrying an effort is refused before spawn (verified 2026-09-21) | ✔ `--effort low\|medium\|high\|xhigh\|max` | ✔ `--effort low\|medium\|high` | ✘ none in help | ✔ `--variant` (provider-specific: high, max, minimal) |
| File-change / tool events | ❓ `--json` emits JSONL; event taxonomy must be captured at runtime (Zod-validate, degrade gracefully) | ❓ `stream-json` events incl. optional hook lifecycle; taxonomy runtime-captured | ❓ `stream-json`; `--json-schema` applies to final result only | ✘ | ❓ `--format json` “raw JSON events”; runtime-captured |
| Subagents / background | ◐ `agents` (app-server daemon sessions), `app-server`, `exec-server` (experimental) | ✔ `--bg/--background` + `claude agents`; `--agents <json>` custom agents | ◐ `agy agent(s)` lists agents (returned empty, exit 0, at inspection) | ◐ `--acp` Agent Client Protocol server; `--agent <name>` | ◐ `serve` headless server, `attach <url>`, `acp` |
| Auth detection command | ✔ `codex login status` → `Logged in using ChatGPT`, exit 0 (verified). **Stream drift:** 0.149.1 printed that line on stdout; 0.154.0 prints it on **stderr** with empty stdout, still exit 0 (verified 2026-09-09). Interleaf therefore accepts the exact allowed status from either stream and treats a second stream that is diagnostic, unrecognized, or conflicting as `unknown` rather than connected | ✔ `claude auth status` → machine-readable JSON `{loggedIn, authMethod, apiProvider}`; **exit code 1 when logged out despite valid JSON** (verified) | ✘ no login/logout/status subcommand in 1.1.13 | ✘ `login` exists (OAuth device flow) but **no status subcommand** | ◐ `providers list` prints credentials (TUI box drawing, count-parseable; 1 credential found: OpenAI oauth) |
| Interactive auth flow | `codex login` / `logout` | `claude auth login` / `logout` / `setup-token` | none exposed — handled inside TUI | `copilot login` (device flow) | `providers login [url]` / `logout` |
| Prompt via stdin | ✔ documented (`-`, or piped stdin appended as `<stdin>` block) | argument `[prompt]`; stdin piping standard for print mode — verify at runtime | ❓ argument-based; stdin unverified | ❓ argument-based; stdin unverified | ✔ positional `[message..]`; stdin unverified |
| Git-repo requirement | ⚠ refuses outside a Git repository unless `--skip-git-repo-check` (both `exec` and `exec resume`) | none observed | none observed | none observed | none observed |
| Ephemeral / no-persist | ✔ `exec --ephemeral` | ✔ `--no-session-persistence` (print only) | ✘ | ✘ | ✘ |

### Dangerous / bypass modes — MUST be gated behind explicit user selection + HIGH/CRITICAL visuals (see `docs/SECURITY.md`)

| CLI | Flag(s) | Help-stated warning |
|---|---|---|
| codex | `--dangerously-bypass-approvals-and-sandbox`; `-s danger-full-access`; `--dangerously-bypass-hook-trust` | “EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed” |
| claude | `--dangerously-skip-permissions`; `--allow-dangerously-skip-permissions` | “Bypass all permission checks. Recommended only for sandboxes with no internet access.” |
| agy | `--dangerously-skip-permissions` | “Auto-approve all tool permission requests without prompting” |
| copilot | `--yolo` ≡ `--allow-all` ≡ `--allow-all-tools --allow-all-paths --allow-all-urls` | “required for non-interactive mode” — i.e. `-p` is effectively unusable without granting broad permissions |
| opencode | `--dangerously-skip-permissions` | “auto-approve permissions … (dangerous!)” |

---

## 4. Normalization for `AIProvider` (chat adapters)

Chat = inference surface; editing/shell tools disabled or strongly restricted (master prompt §§36–38). Recommended canonical invocation shapes:

| Provider | Chat invocation skeleton |
|---|---|
| Codex | *Genuinely tool-free transport unavailable.* Connected ChatGPT subscriptions use Interleaf's explicitly user-authorized constrained Reader Chat path: canonical binary, main-owned private empty cwd, `--sandbox read-only`, `approval_policy="never"`, `--ignore-user-config`, `--ignore-rules`, minimal allowlisted environment, bounded I/O/time, cancellation, and fail-closed abort on unsupported tool/events. Codex's built-in tool surface remains and this is residual-risk containment, not a tool-free guarantee. |
| Claude Code | `claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --safe-mode --disable-slash-commands --strict-mcp-config --no-session-persistence [--model M]` — `--tools ""` disables all built-in tools; hardened with safe mode and strict MCP config. **`--verbose` is required, not optional:** Claude Code 2.1.267 refuses `--print` with `--output-format stream-json` unless it is present, writing `Error: When using --print, --output-format=stream-json requires --verbose` to stderr and exiting 1 *before* any inference, which surfaces in Interleaf only as a generic provider failure because raw CLI stderr is deliberately never logged or shown. The model-listing probe in §7.9a already passed `--verbose` for the same reason. |
| Antigravity | *Tool-free chat mode unavailable.* `agy` 1.1.13 / 1.1.19 has no flag to disable tool execution; restricted to Agent Mode. |
| Cursor | *Tool-free chat mode unavailable, and unverifiable here.* `cursor-agent` has never been installed or probed on this host (§1), so no tool-disabling flag can be claimed. The provider is registered only so the listing is complete; it carries a permanent `chatUnavailableReason` and is never spawned for Reader Chat. Agent Mode only. |
| Pi | `pi --mode json --print --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session --no-approve --offline --system-prompt "<Reader AI prompt>" --append-system-prompt "" --model <provider/model>` — genuinely tool-free on 0.84.4: `--no-tools` removes every built-in, extension and custom tool, and the `--no-*` discovery flags stop Pi loading project- or user-owned extensions, skills, prompt templates, themes, context files or trust prompts. `--append-system-prompt ""` is required, not cosmetic: without it Pi appends a discovered `~/.pi/APPEND_SYSTEM.md` or trusted project `.pi/APPEND_SYSTEM.md` to whatever system prompt is in force. **`--offline` scope:** it suppresses Pi's startup, update, catalog and telemetry traffic only; the selected remote model request still goes out, which is the turn itself. There is no hosted web search on this path. Document, history and question travel on stdin, and the Reader AI prompt is *not* repeated there because Pi already received it as `--system-prompt`. Streaming reads only `message_update.assistantMessageEvent.type === "text_delta"`; tool use is a fail-closed violation whether it arrives as a `tool_execution_*`/`toolcall_*` event or inside an aggregate `AgentMessage` (a `toolResult` message, a `toolUse` stop reason, or a `toolCall` content part in `message_start`/`message_end`/`turn_end`/`agent_end`). |
| Omp | `omp --mode json --print --no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules --no-session --no-title --approval-mode always-ask --system-prompt "<Reader AI prompt>" --append-system-prompt "" --cwd <private empty app-owned dir> --model <selector>` — genuinely tool-free on 18.1.16 in the same sense as Pi: `--no-tools` removes the tool surface, `--no-lsp`/`--no-pty` remove the language-server and terminal surfaces, and `--no-extensions --no-skills --no-rules --no-session --no-title` stop Omp loading or writing project- and user-owned material. `--approval-mode always-ask` is a backstop, not the control: with no tools there is nothing to approve, and Interleaf answers no prompt. **Omp has no `--offline` flag.** Interleaf therefore claims *tool-free chat* for Omp and claims nothing about Omp's own network traffic; the selected model request is remote in any case. Document, history and question travel on stdin; the Reader AI prompt is the one argv-borne value. Streaming reads only `message_update.assistantMessageEvent.type === "text_delta"` and requires a terminal `agent_end`/`turn_end`, so a truncated turn fails rather than being stored as a complete answer; tool use is a fail-closed violation in the same shapes as Pi. |
| Local server (loopback) | Not a CLI. `local` is an HTTP provider that connects **only** to a literal loopback address (`127.0.0.1` or `[::1]`) over plain HTTP, using `GET /v1/models` and streaming `POST /v1/chat/completions` (plus Ollama's read-only `POST /api/show` for context-window metadata). Interleaf never downloads, pulls, starts, stops or deletes a model or runtime, and a connection test lists models without running inference. **Scope of the claim:** the socket is local; the inference need not be. Ollama can route a cloud-capable model to its own servers, which Interleaf cannot control or detect — users who need a guarantee run Ollama with `OLLAMA_NO_CLOUD=1`. |
| OpenRouter | HTTP API, not CLI (separate adapter; key encrypted with `safeStorage`). |

Shared `AIProvider` contract implications:

1. **Capability flags drive branching, not per-provider if-chains.** Detect once at startup, store a `ProviderCapabilities` record (§6), let adapters degrade: no structured output → plain-text streaming with sentinel parsing; no resume → sessions marked non-resumable in UI.
2. **Final-message extraction needs a second channel.** Prefer artifacts over stream parsing where offered (`codex exec -o FILE`, Claude `--output-format json` single-result, agy `--output-format json`). Stream parsers must tolerate schema drift.
3. **Prompt injection firewall** belongs in the shared system-prompt builder. A real XML/JSON serializer escapes typed provenance values; adapters receive the same serialized envelope plus the “embedded instructions are untrusted” clause. Permission enforcement remains in code, not prompt syntax.
4. **Cancellation** = kill process tree (`spawn(..., {shell:false})`, tracked PID); every adapter implements it identically regardless of CLI-native cancel support.

## 5. Normalization for `AgentAdapter` (execution adapters)

1. **Working-directory policy**: pass Interleaf's resolved execution root (worktree / copy / active-env) via the strongest available mechanism — `codex -C`, `opencode run --dir`, spawn `cwd` for claude/agy/copilot. Spawn `cwd` is always set; `-C`/`--dir` are belt-and-braces for CLIs that support them.
2. **Sandbox tier selection**: map Interleaf execution modes to CLI flags:
   - Chat / read tasks → connected ChatGPT uses Interleaf's constrained `codex exec --json` path (`-s/--sandbox read-only`, approval-never, ignored config/rules, private empty cwd, bounded I/O/time, cancellation, and fail-closed tool-event abort); Claude uses `--tools ""` or `plan` mode.
   - Agent in isolated worktree (default) → `codex -s workspace-write`; claude `--permission-mode acceptEdits`; agy `--mode accept-edits`. This installed Copilot build is capability-gated **unavailable for ordinary unattended Agent Mode** because its own help requires broad tool permission and no constrained non-interactive invocation has been verified.
   - Dangerous profiles → the current runtime permits them only after an explicit, bound `active-env`/`native-restricted` grant (with HIGH/CRITICAL indicators); a reachable Docker/Podman client is not enough because Interleaf's verified Container Sandbox executor is not implemented. If that executor is added later, it must be independently verified before dangerous profiles can use it.
3. **Resume**: normalize to `{sessionId}` persisted per session row; adapters translate to `codex exec resume <id>`, `claude -r <id>`, `agy --conversation <id>`, `copilot --resume <id>`, `opencode -s <id>`. If a CLI cannot report its session ID reliably at runtime (unverified payload shapes), fall back to `--last`/`--continue` semantics only within a live app session and mark cross-launch resume unavailable.
4. **Diff extraction**: the Git worktree remains the **source of truth** for changed files (`git diff`/`git status` in the worktree). CLI file-change events (❓ rows above) are advisory UI hints only — never authoritative — because their payload schemas are version-dependent.
5. **Exit-code contract**: all adapters capture stdout/stderr/exit code/start/end timestamps uniformly; nonzero exit ⇒ `Failed` status with stderr attached. Copilot-specific pre-flight: its own help marks `--allow-all-tools` as *required* for non-interactive mode, so ordinary unattended launch fails closed. Broad Copilot permission is allowed only inside verified container containment or after the documented bound critical-risk grant; Interleaf never silently widens permissions to satisfy `-p`.
6. **Custom profiles** (master prompt §52): the placeholders `{{workingDir}} {{promptFile}} {{sessionId}} {{model}}` map onto exactly the flag surfaces in §3; expose per-capability toggles so users can't select a resume/model option the detected binary lacks.

### 5.1 Pi unattended Agent Mode contract (pi 0.84.4, verified 2026-09-21)

Read off the installed package's own sources — `dist/cli/args.js` (`parseArgs`),
`dist/cli/initial-message.js` (`buildInitialMessage`), `dist/main.js`
(`readPipedStdin`, `resolveAppMode`, offline handling), `dist/modes/print-mode.js`,
`docs/json.md`, `docs/security.md`, `README.md` — plus parse-only probes that
imported `parseArgs`/`buildInitialMessage` directly. **No model was invoked.**

**Argv (fixed, tokenized, `shell: false`):**

```
pi --print --mode json \
   --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
   --no-session --no-approve --offline \
   [--model <id>] [--thinking <level>]
```

| Token | What the source shows it does |
|---|---|
| `--print --mode json` | `resolveAppMode` returns `"json"`; print mode writes one JSON event per line to stdout. Non-interactive: `docs/security.md` states `-p` and `--mode json` **do not show a trust prompt**. |
| `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files` | Stop Pi discovering and loading user- or project-owned resources. The agent's working copy is untrusted content; this is the only containment Pi offers. |
| `--no-session` | No session store is written. |
| `--no-approve` | Sets `projectTrustOverride = false` (confirmed by parse probe). Project trust governs loading `.pi` settings and **executing project extensions**; pinning it to "no" ignores any stored decision rather than consulting or extending one. `--approve`/`-a` is refused outright: `assertPiStoredArgv` requires the stored settings argv to equal the preset above exactly, and `assertPiUnattendedArgv` then allows only Interleaf's own `--model`/`--thinking` selections after it. |
| `--offline` | Suppresses startup network operations and the version check (`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`). The model request itself is still remote — that is the turn. |
| `--thinking <level>` | Accepts `off, minimal, low, medium, high, xhigh, max`. Interleaf's effort enum is a subset, but an unrecognised level is only a **warning** and Pi then runs at its default, so the value is re-checked before it is sent. |

**Prompt delivery is stdin, and that is a safety property, not a style choice.**
`parseArgs` treats a positional beginning with `@` as a file to include — *even
after `--`* — and `--print` consumes the following token as the message unless
that token looks like a flag. A prompt of `@/etc/passwd …` or `--help` in argv
would therefore change what Pi does. `readPipedStdin` returns the piped text and
`buildInitialMessage` makes it the whole initial message; parse probes confirmed
`messages: []` and `fileArgs: []` for the preset above and verbatim delivery of
`@`- and `-`-leading prompts.

**Risks this contract does not remove, and does not claim to:**

- **No sandbox and no approvals, at all.** `docs/security.md` has a "No Built-in
  Sandbox" section; `README.md` states "No permission popups." Tools are enabled
  by default and there is nothing to approve. Pi is therefore permanently
  `unsafe` (`ALWAYS_UNSAFE_AGENT_PROVIDERS`), which routes every run through the
  existing critical-risk path: a fresh bound native confirmation per start, a
  dangerous-profile environment, and refusal of Native Restricted. No permission
  mode in settings can downgrade it. Pi must never be presented as
  approval-respecting.
- **No file-change and no test events.** Pi's JSON events carry no
  `changed-files` or `tests` discriminator. Changed files come from the
  worktree, as §5.4 requires.
- **JSON mode exits 0 even when the turn errored** (`print-mode.js` sets a
  nonzero code only in text mode), so exit code alone does not report failure
  for Pi. The outcome is on the assistant message —
  `stopReason: "error" | "aborted"` with `errorMessage`, delivered on
  `message_end`/`turn_end` — and `src/main/agents/pi-stream.ts` translates it
  into a typed error or a cancellation before anything downstream can read the
  run as a success.
- **The reply and the final report are translated, not native.** The same
  translation projects Pi's assistant text onto the `assistant_message` shape
  the activity feed renders and emits one `final` event from a completed
  assistant message's text. The report is withheld — not truncated — on a
  dropped-frame summary, a bound overrun, an error, a cancellation, a non-zero
  exit, or a signal, so a partial stream is never presented as the answer.
  It is **not** a completeness guarantee: a later assistant message that is
  empty or over-bound replaces nothing, and Pi's non-final stop reasons
  (`toolUse`, `length`, `deferred`) are not distinguished from a terminal
  `stop`, so an intermediate message can survive as the report. This is a known
  P2 limitation.
- **Resume is not wired.** `sessionResume: false`; a resume is refused.

## 6. Proposed `AgentCapabilities` record (shared type sketch)

```ts
interface AgentCapabilities {
  installed: boolean;                 // safe renderer-facing state; path stays main-only
  version: string | null;
  nonInteractive: boolean;
  structuredOutput: 'none' | 'events-jsonl' | 'stream-json' | 'single-json';
  finalAnswerArtifact: 'stdout' | 'file-flag' | 'single-json';
  sessionResume: 'none' | 'id' | 'lastOnly';
  nativeSandbox: 'none' | 'toolGating' | 'osSandbox';
  sandboxModes?: string[];            // e.g. ["read-only","workspace-write","danger-full-access"]
  workingDirectory: 'spawnCwd' | 'flag' | 'flagPlusSpawnCwd';
  wdFlag?: string;                    // "-C" | "--dir" | undefined
  modelSelection: boolean;
  reasoningSelection: boolean;
  reasoningFlag?: string;             // "--effort" | "--variant" | undefined
  dangerousFlags: string[];           // for UI gating + warnings
  fileChangeEvents: boolean;          // advisory only — git diff stays authoritative (§5.4)
  toolEvents: boolean;
  subagents: boolean;                 // background/daemon agent surface
  interactiveAuthentication: boolean; // CLI owns its login flow; Interleaf never touches credentials
  authDetection: 'command' | 'commandJson' | 'heuristic' | 'none';
  gitRepoRequired: boolean;           // true => pass --skip-git-repo-check outside repos
}
```

## 7. Facts that MUST be probed dynamically at runtime

Static docs go stale; the detection layer must re-establish these per launch (cache keyed by binary mtime/hash):

1. **Presence + absolute path** — `PATH` lookup per spawn, never a cached path from Settings. A Finder-launched macOS app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, so on macOS the lookup PATH — and the PATH of every provider/agent child — is the inherited PATH followed by whichever of `~/.local/bin`, `~/.bun/bin`, `~/.nvm/versions/node/v*/bin` (newest first, one bounded directory read), `/opt/homebrew/bin` and `/usr/local/bin` exist (`src/main/app/cli-search-path.ts`). No shell or startup file is consulted and `process.env` is not mutated; other platforms keep their inherited PATH. A resolver that exits 1 on its own means the CLI is absent ("not installed"), not a failed sign-in check.
2. **Version string parse** — formats differ (`codex-cli 0.149.1`, `2.1.210 (Claude Code)`, bare `1.1.13`); store raw string + parsed semver where possible. Copilot's 0.x→1.x jump proves capability sets can change discontinuously.
3. **Auth state** —
   - codex: run `codex login status`, check exit code + text, and **read both streams** — the line moved from stdout (0.149.1) to stderr (0.154.0) while the exit code stayed 0. Classify each stream against the exact allowed status independently; an empty stream says nothing, and a diagnostic, unrecognized, or conflicting second stream downgrades the result to `unknown`.
   - claude: run `claude auth status`, parse JSON; **treat exit≠0 as "logged out" only in combination with `loggedIn:false`** (exit 1 accompanies a valid logged-out JSON — don't classify as crash).
   - opencode: parse `providers list` output for credential entries.
   - copilot / agy: **no status command exists**. Heuristics only (config-dir existence: `~/.copilot` present; Antigravity state under `~/Library/Application Support/antigravity` + `~/.antigravity` — both present on this machine). Treat as `unknown`, never `connected`, until the user clicks **[Test]** in Settings (an explicit, paid, user-initiated minimal prompt).
4. **Docker daemon reachability** — `docker info` succeeds/fails independently of client presence. At inspection: client fine, daemon down (`colima` socket missing). The current Container Sandbox option remains unavailable even when this probe finds a client/daemon, because a verified Interleaf container executor is still required.
5. **Structured-event schemas** — JSONL/stream-json taxonomies (event names, session-ID fields, tool/file-change payloads) are not documented in help and were not exercised (paid runs prohibited). On first real run: capture events, Zod-validate, log unrecognized event types, degrade to plain-text passthrough on parse failure. Never hard-fail a session because an event didn't match.
6. **Stdin prompt acceptance** for claude/agy/copilot/opencode — verify with a trivial probe before relying on `{{promptFile}}`/stdin delivery in custom profiles.
7. **Codex reasoning-effort config key** — the installed config schema (Codex 0.162.1) documents `model_reasoning_effort`, and `model/list` publishes per-model `supportedReasoningEfforts`. Reader Chat uses both: the levels come from the listing at runtime, never from a static table, and `-c model_reasoning_effort="X"` is sent only for a listed level (docs/AI_ARCHITECTURE.md §1.5). End-to-end honouring under `--ignore-user-config` is inferred from the schema, not observed in a paid run. Agent Mode still fails closed for Codex effort. `sandbox_mode` is unaffected: it is a documented config key and remains the resume sandbox carrier.
8. **Git-repo detection at target root** — determines whether `--skip-git-repo-check` must be injected for Codex (isolated-copy / non-Git dirs).
9. **Accepted `--model` identifiers** — §3 records each CLI's `--model` *flag* surface, not its valid values. Interleaf still ships **no** static agent-CLI model catalog; instead, §7.9a lists the per-CLI **listing** mechanisms re-inspected on 2026-09-08, which main runs as bounded probes at runtime (`src/main/agents/model-discovery.ts`). The Agent panel's picker is assembled by `resolveAgentModelOptions` (`src/shared/constants/agent-models.ts`) from the profile's configured default, the user's bounded per-profile list in Settings, whatever the installed CLI reported, and a small repo-evidenced seed table — in that order; see the model-selection section of `docs/AGENT_RUNTIME.md`. Do not grow that seed table into a second, drifting catalog — an identifier belongs there only when this repository already evidences it as CLI-valid.

### 7.9a Model-listing mechanisms (re-inspected 2026-09-08, read-only, no model prompts)

Every mechanism below is a *listing* call: none of them starts a model turn, so discovery issues no paid request. Each runs as a fixed executable with tokenized argv, `shell: false`, `buildMinimalChildEnvironment()`, bounded output/time, in a main-owned neutral directory — never a user project root, because these CLIs load project-local config, hooks, skills and extensions from their working directory.

| CLI | Observed listing mechanism | Identifier taken | Notes / limits |
|---|---|---|---|
| `codex` 0.153.4 | `codex app-server --listen stdio://`, line-delimited JSON-RPC: `initialize`, then `model/list` | entry `model` (falls back to `id`; both were identical strings here) | Local; no network observed. The `initialize` result also carries `codexHome` — main reads identifiers only, so no path crosses IPC. |
| `claude` 2.1.263 | `claude -p --bare --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --tools ""` + a `control_request` of subtype `list_models` | response entry `value` | `--bare` is load-bearing: it suppresses hooks, plugins, LSP, memory and `CLAUDE.md` discovery, so no project- or user-owned extension is executed to list models. `resolvedModel` is deliberately ignored. **Limit:** alias values containing brackets (observed: `claude-fable-5-1[1m]`) fail `AGENT_MODEL_ID_PATTERN` and are dropped rather than forwarded into argv; the pattern is not relaxed for them. |
| `pi` 0.84.4 | `pi --offline --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --list-models` | first two whitespace-aligned columns joined as `provider/model` | Exit 0, local only. Header row (`provider  model …`) is skipped. |
| `pi` 0.84.4 (Reader Chat) | `pi --mode rpc --offline --no-session --no-tools --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve`, then one stdin frame `{"id":"interleaf-chat-models","type":"get_available_models"}` | `provider/id` from each `data.models[]` entry, validated as a Pi model ID | A metadata command: no turn starts. The `--list-models` table has no reasoning columns, so Reader Chat uses RPC to read `reasoning` and `thinkingLevelMap` under Pi's own supported-level rule: no reasoning → `off` only; else the base levels minus those mapped to `null`, plus `xhigh`/`max` only where mapped. Main stops the server once the matching `response` arrives. |
| `omp` 18.1.16 | `omp models --json --no-extensions` | entry `selector`, validated against a bounded `provider/model` pattern | Exit 0, no credential emitted and no model invoked. The payload is large (188 KB / 589 entries here), so it gets its own 4 MiB bound rather than the shared 64 KiB diagnostic bound, and the exposed catalog is capped at 128 entries selected round-robin across providers so one provider cannot crowd out the rest. Names are stripped of control characters and deduped; token counts are clamped, with conservative defaults when absent. |
| `agy` 1.1.27 | `agy models` | text before the first tab (`id<TAB>display name`) | **Limit:** this refreshes the catalog over the network. It is still a listing, not an inference call. |
| `opencode` 1.18.23 | `opencode --pure models` | whole trimmed line, already `provider/model` | `--pure` avoids loading external plugins. |
| `copilot` 0.0.410 | **None.** Accepted `--model` values appear only in `--help` prose; there is no listing subcommand. | — | Detection already reports Copilot unavailable for unattended Agent Mode, so a catalog would unlock nothing. No probe is declared. |
| `cursor-agent` | **None declared.** The binary was never installed or run (§1), so no listing subcommand has been observed and none is guessed. | — | Cursor's models come from the user's own per-profile list in Settings until someone probes the real binary. |
| `custom` / `fake` profiles | **Never probed.** | — | A custom profile's models are the user's own configuration; the fixture is deterministic. |

Common limits: a probe that times out, exceeds its output bound, loses events to the runner's bounded queue, is cancelled, or ends **on its own** with a non-zero or signalled exit contributes **nothing** — a partial answer is never promoted into a catalog, and a failure or cancellation reported after a whole reply was already collected overrides that reply. The one exit status that is not read as failure is the probe's own deliberate stop after a collector has already parsed a whole reply: the server-style CLIs above answer while stdin stays open and would otherwise never exit, so main terminates them once the answer is complete and that termination's status describes the stop, not the listing. A provider that does not answer simply leaves the profile's existing options in place. Discovered identifiers are runtime-only: they are never persisted, and they pass the same `isAgentModelIdentifier` guard and bound as every other allowlist entry.

Probe children run through `ProcessRunner`, the same lifecycle the launch path uses, so a listing CLI that leaves inherited descendants behind is still terminated as a process tree and a probe is never reported complete before that cleanup is proven. That proof is enforced, not assumed: probes run with the runner's strict cleanup policy, so when termination cannot be verified — the POSIX group still present when the bounded reap window closes, or the Windows tree helper unavailable, failed, or still unverified after its grace — the probe fails with no catalog for that pass rather than reporting one from an unverified state. Discovery is owned: one probe per provider at a time, refreshes coalesced, and everything cancelled and awaited during `AgentService.shutdown`.

---

## Appendix A — Exact commands inspected (all read-only)

```text
which / command -v codex claude agy copilot opencode docker git pi podman
codex --version                     -> codex-cli 0.149.1
codex --help                        (top-level options/subcommands)
codex exec --help                   (non-interactive interface)
codex exec resume --help            (resume semantics)
codex sandbox --help                (standalone sandboxed command runner)
codex login status                  -> "Logged in using ChatGPT", exit 0
                                       (0.149.1: on stdout; re-run on 0.154.0, 2026-09-09:
                                        exit 0, stdout empty, "Logged in using ChatGPT" on stderr)
codex app-server --help             -> experimental stdio/listen server; no tool-disable option
codex app-server generate-json-schema --out <temporary-dir> -> sandbox/approval schemas only; no deny-all shell/tool profile
claude --version                    -> 2.1.210 (Claude Code)
claude --help                       (full option surface incl. -p, output formats, permission modes)
claude auth status                  -> {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}, exit 1
agy --version                       -> 1.1.13
agy --help  /  agy help             (flag surface + subcommand list; no login/status subcommand)
agy agent                           -> empty output, exit 0
agy models                          -> model catalog fetch (read-only listing, no tokens)
agy changelog                       -> upstream latest 1.1.19 (installed 1.1.13 older)
copilot --version                   -> GitHub Copilot CLI 0.0.410
copilot --help                      (option surface incl. -p/--allow-all-tools coupling, --yolo)
copilot login --help                (OAuth device flow; no status subcommand anywhere)
copilot version                     -> also advertises update to 1.0.80
opencode --version                  -> 1.14.18
opencode --help                     (commands incl. run/serve/acp/providers/session)
opencode run --help                 (non-interactive flags incl. --format json, --dir, --variant)
opencode providers --help           (list/login/logout)
opencode providers list             -> 1 credential (OpenAI oauth)
docker --version                    -> 29.2.1, build a5c7197d72
docker info --format '...'          -> FAILED: colima socket absent (daemon down)
docker context ls                   -> colima (default) + default contexts
[ -d ] checks: ~/.codex ~/.claude ~/.copilot ~/.local/share/opencode present; ~/.agy absent;
              ~/Library/Application Support/antigravity + ~/.antigravity present
```

Not executed (prohibited / unnecessary): any `-p`/`exec`/`run` model invocation, any `login`/`logout`/`update` command, any write into `~/.codex`, `~/.claude`, `~/.copilot`, opencode data dir, or application code.

## Appendix B — Model-listing re-inspection, 2026-09-08 (read-only, no model prompts)

Backs §7.9a only. Host: macOS Darwin 25.6.0, arm64.

```text
codex --version / claude --version / agy --version / copilot --version / opencode --version / pi --version
codex app-server --listen stdio://  <- {"jsonrpc":"2.0","id":1,"method":"initialize",...}
                                       {"jsonrpc":"2.0","id":2,"method":"model/list","params":{"limit":64}}
                                    -> one JSON-RPC frame per line; result.data entries carry id + model
claude -p --bare --input-format stream-json --output-format stream-json --verbose
       --strict-mcp-config --tools ""   <- {"type":"control_request","request_id":…,
                                            "request":{"subtype":"list_models"}}
                                        -> control_response, response.models[].value (+ resolvedModel)
pi --offline --no-extensions --no-skills --no-context-files --no-prompt-templates
   --no-themes --no-approve --list-models  -> whitespace-aligned table, exit 0
agy models                                 -> id<TAB>display name (refreshes over the network)
opencode --pure models                     -> provider/model per line
copilot --help                             -> --model documented in prose only; no listing subcommand
```

Not executed: any prompt, session, login or write. No probe was run against a project directory.
