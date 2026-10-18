[Wiki home](../README.md) › [AI providers](../ai-providers.md) › OpenCode

# OpenCode

OpenCode is a working agent integration with no Reader Chat side, so it never
appears in the chat provider menu. This page also explains why GitHub Copilot
is not offered at all.

---

## GitHub Copilot

**GitHub Copilot is not offered in Interleaf.** Unattended agent runs need a
tool that can run non-interactively with structured output, and this
integration does not have a Copilot contract it can rely on for that. So there
is no Copilot row in **Settings ▸ AI Providers**, no Copilot entry in the agent
list, and it cannot be chosen as the default agent.

- **Installing the `copilot` CLI does not add it**, and there is no setting,
  permission choice or flag that turns it on.
- **Older settings and conversations keep working.** If an earlier version saved
  Copilot as a preference or a run, that data is kept as it was, but it cannot
  be run. Starting such a run is rejected with:

  > GitHub Copilot CLI is unavailable for unattended Agent Mode.

**What to do instead.** Pick another agent profile — Codex, Claude Code,
Antigravity, OpenCode or Pi. See the
[capability matrix](../ai-providers.md#the-capability-matrix).

---

## OpenCode

| | |
| --- | --- |
| **Shown in Interleaf as** | OpenCode |
| **AI Chat** | ❌ No |
| **AI Agent** | ✅ Yes — profile **OpenCode** |
| **Needs** | The `opencode` command-line tool |
| **Session resume** | ❌ No |

Interleaf's own description: *OpenCode CLI. Available in Agent Mode only.*

**Setup.** Install OpenCode yourself. The **Installation help** action links to
<https://opencode.ai/docs/> Then expand the **OpenCode** row in **Settings ▸ AI
Providers**.

**What to expect during a run.** OpenCode streams structured output, tool
activity and file-change events, supports subagents, and offers model and
reasoning-effort selection. It has no native sandbox of its own, so use one of
Interleaf's isolated execution modes.

---

## Notes

- OpenCode cannot answer AI Chat. Use a provider marked ✅ in the
  [capability matrix](../ai-providers.md#the-capability-matrix).
- OpenCode does not support resuming a finished session — only
  [Codex](chatgpt-subscription.md) does.
- OpenCode runs under Interleaf's isolated execution modes; see
  [AI Agent ▸ Execution environments](../ai-agent.md#execution-environments).
  Remember that an isolated workspace directs where work happens and is not an
  operating-system boundary around the CLI.
- If **Start agent** is blocked with *OpenCode is not installed on this
  machine.*, the binary was not found.

---

Related: [AI providers](../ai-providers.md) · [AI Agent](../ai-agent.md) ·
[Antigravity](antigravity.md)
