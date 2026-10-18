[Wiki home](../README.md) › [AI providers](../ai-providers.md) › Omp

# Omp

| | |
| --- | --- |
| **Shown in Interleaf as** | Omp |
| **AI Chat** | ✅ Yes, in tool-free mode |
| **AI Agent** | ❌ No — deliberately |
| **Needs** | The `omp` command-line tool, signed in to a model provider |
| **Hosted web search** | ❌ No |

Interleaf's own description: *Subscription-backed. Reader Chat only: Interleaf
runs it in tool-free JSON mode and gives it no Agent Mode profile.*

---

## Setup

1. **Install the Omp CLI** yourself. Interleaf's **Installation help** action
   links to <https://omp.sh>
2. **Sign in to a model provider** through Omp.
3. In Interleaf, open **Settings ▸ AI Providers** and expand the **Omp** row —
   it is the last row in the list.

If Omp is installed but no model provider is signed in, chat reports:

> Sign in to an Omp model provider to use Omp for AI Chat.

---

## Why there is no Agent Mode

This is a design decision, not an oversight. Interleaf gives Omp no agent
profile at all, and runs it only in tool-free JSON mode for Reader Chat. There
is nothing to enable, and it will not appear in the agent's **Agent** profile
menu.

If you want an agent, use [Codex](chatgpt-subscription.md),
[Claude Code](claude-code.md), [Pi](pi.md), [Antigravity](antigravity.md) or
[OpenCode](agent-only-clis.md) — see [AI providers](../ai-providers.md).

---

## Models

Omp's model list is **discovered at runtime** from the CLI. A question is never
sent against a selector the CLI did not publish. Before discovery runs, you may
see the placeholder **Omp CLI default**.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not installed** | The `omp` binary was not found. Install it, then reopen the row. |
| **Sign-in status unknown** | Interleaf does check: it runs a bounded `omp models --json --no-extensions` listing. Omp already limits that catalogue to providers you are signed in to, so a non-empty list means connected and an empty one means signed out. **Unknown** means the probe itself was inconclusive — not that no check exists. Confirm the CLI runs from your terminal, then reopen the row to re-run detection. The probe sends no credential and runs no inference. |
| Empty model menu | Sign in to a model provider inside Omp, then re-check. |
| Omp missing from the agent profile menu | Expected — Omp has no agent profile. |

---

Related: [AI providers](../ai-providers.md) · [Pi](pi.md) ·
[AI Chat](../ai-chat.md)
