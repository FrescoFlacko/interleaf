[Wiki home](../README.md) › [AI providers](../ai-providers.md) › Antigravity

# Antigravity

| | |
| --- | --- |
| **Shown in Interleaf as** | Antigravity |
| **AI Chat** | ❌ No — unavailable with this CLI version |
| **AI Agent** | ✅ Yes — profile **Antigravity** |
| **Needs** | The `agy` command-line tool |
| **Session resume in Agent Mode** | ❌ No |

Interleaf's own description: *Runs via Google account subscription tools.
Available in Agent Mode only.* Its status row reads **Agent Mode only**.

---

## Why AI Chat is not available

Interleaf's Reader Chat is built around a provider that can answer a question
from attached context **without using tools**. Antigravity's CLI has no verified
tool-free mode, so Interleaf refuses to use it for chat rather than running it
with tools enabled against your document text. The message is:

> This Antigravity CLI version has no verified tool-free chat mode; it remains
> available for Agent Mode only.

This is not a toggle, a permission or a missing sign-in, so there is nothing to
configure: Antigravity does not appear in the chat provider menu. It is,
however, a statement about *this CLI version and this integration* — "no
verified tool-free chat mode" — rather than a permanent product decision. For
chat today, use one of the providers marked ✅ in the
[capability matrix](../ai-providers.md#the-capability-matrix).

---

## Setup for Agent Mode

1. **Install the Antigravity CLI** yourself. Interleaf's **Installation help**
   action links to <https://antigravity.google/docs>
2. Sign in through the tool's own flow.
3. In Interleaf, open **Settings ▸ AI Providers** and expand the **Antigravity**
   row. The row shows the profile editor; its status reflects whether the `agy`
   binary was detected.

---

## Using it for AI Agent

Select **Antigravity** as the **Agent** profile in the agent panel's **Run
settings**.

It supports structured output, tool activity and file-change events during a
run, plus model and reasoning-effort selection. It does not support subagents,
and it does not support session resume.

**Native Restricted is not available for Antigravity.** Interleaf only offers
that mode to a CLI whose own sandbox it can verify — a bounded, non-inference
check of the executable's `--version` and `--help` output, re-run before every
start. `agy` exposes no enforceable native-sandbox flag Interleaf can prove, so
the mode stays unavailable rather than quietly running with less containment
than its name promises. Codex is currently the only profile that passes that
check. Use one of the isolated modes instead.

See [AI Agent](../ai-agent.md) for the full workflow.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Antigravity is not in the chat provider menu | Expected with this CLI version. See above. |
| **Native Restricted** is greyed out or refuses to start | Expected. Only Codex currently proves a supported native sandbox; choose an isolated mode. |
| **Agent Mode only** with a grey dot | The `agy` binary was not detected. Install it and reopen the row. |
| *Antigravity is not installed on this machine.* on **Start agent** | Same cause — the binary is missing. |

---

Related: [AI providers](../ai-providers.md) · [AI Agent](../ai-agent.md) ·
[OpenCode](agent-only-clis.md)
