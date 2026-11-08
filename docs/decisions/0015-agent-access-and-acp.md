# ADR 0015: Local agent access and ACP

## Status
Proposed with local MCP boundary; ACP adoption deferred. Research verified 2026-11-08.

## Context
Agents need bounded, revision-aware access to a reader's local library, plus a way to suggest work without gaining authority to edit source documents. Interleaf already owns agent process lifecycles, workspaces, cancellation, and approval controls in main. A transport protocol does not replace these controls.

## Decision
Expose local MCP tools through an authenticated loopback endpoint, read-only unless the reader explicitly enables pending proposal submission. A local user reviews proposals; acceptance is a main-owned transaction. An MCP client may not approve proposals, run commands, read arbitrary paths, or write documents. Passage links use document IDs and revision-bound indexed chunk references, resolved in main; changed or missing sources fail. The token is transient and copied only on a deliberate native action. Any local process possessing it can read the library; the token is not an OS sandbox against a malicious same-user process. Treat all document and agent text as untrusted.

The implementation targets the [2026-07-28 MCP version](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) with per-request metadata and `server/discover`, and supports the legacy 2025-06-18 initialization flow. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) requires Origin validation and defines metadata-header matching; neither identity nor session identifiers authenticate a client.

ACP is a possible separate in-app agent transport, not a replacement assumed safe. The [ACP introduction](https://agentclientprotocol.com/get-started/introduction) defines a client/agent boundary, and [initialization](https://agentclientprotocol.com/protocol/v1/initialization) negotiates optional capabilities. [ACP security](https://agentclientprotocol.com/protocol/v1/security) states the protocol does not sandbox agents and permissions are advisory. The maintained [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) builds on Codex App Server; [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp) uses the Claude Agent SDK. Their specific supported controls and versions must be pinned and verified against Interleaf's invariants before any transition. [Codex App Server](https://learn.chatgpt.com/docs/app-server) describes agent-side process and approval controls, which are not ACP client guarantees.

## Consequences
Existing agent sessions and workflows remain in place. An ACP prototype must separately prove process ownership, cancellation, bounded I/O, sandbox and permission behavior, and workspace authority for each adapter. No assumption of tool-free execution follows from using ACP. MCP read access exposes local library content to anyone holding its transient credential, so clients must be chosen deliberately; browser Origin requests are rejected and the listener is bound to literal loopback.
