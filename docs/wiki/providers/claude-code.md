[Wiki home](../README.md) › [AI providers](../ai-providers.md) › Claude Code

# Claude Code

| | |
| --- | --- |
| **Shown in Interleaf as** | Claude Code |
| **AI Chat** | ✅ Yes, in tool-free mode |
| **AI Agent** | ✅ Yes — profile **Claude Code** |
| **Needs** | The `claude` command-line tool, signed in |
| **Hosted web search** | ❌ No |
| **Session resume in Agent Mode** | ❌ No |

Interleaf's own description of this row: *Subscription-backed. Reader Chat runs
it in safe tool-free mode; Agent Mode uses the profile below.*

---

## Setup

1. **Install the Claude Code CLI** yourself — Interleaf never installs it. The
   app's **Installation help** action links to the official setup guide:
   <https://docs.claude.com/en/docs/claude-code/setup>
2. **Sign in** using the CLI's own authentication flow.
3. In Interleaf, open **Settings ▸ AI Providers** and expand the **Claude Code**
   row to run detection.
4. When it reads **Ready**, chat and agent are both available.

---

## Using it for AI Chat

Pick **Claude Code** in the chat composer's provider menu.

The model is listed as **Claude CLI default**.

For chat, Interleaf runs the CLI in a **tool-free mode**: no tools, safe mode,
slash commands disabled, no session persistence. The model reads the context you
attached and answers from it. This is the behaviour Interleaf's grounded,
cited chat is designed around.

---

## Using it for AI Agent

The agent profile is **Claude Code**. It supports:

- Structured streaming output, tool activity and file-change events during the
  run.
- Model and reasoning-effort selection in **Run settings**.
- Subagents.

It does **not** support session resume: when a run finishes, it finishes. Start a
new task instead. (Only [Codex](chatgpt-subscription.md) can resume.)

It also has no native sandbox of its own, so Interleaf's isolated execution
modes are what keep your project safe — see
[AI Agent ▸ Execution environments](../ai-agent.md#execution-environments).

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not installed** | The `claude` binary was not found. Install it, then reopen the row. |
| **Sign-in required** | Complete the CLI's sign-in, then re-check. |
| Chat is unavailable but the agent works | Chat needs the CLI to be signed in and answering; re-run detection. |

---

Related: [AI providers](../ai-providers.md) · [AI Chat](../ai-chat.md) ·
[AI Agent](../ai-agent.md)
