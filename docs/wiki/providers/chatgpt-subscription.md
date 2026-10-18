[Wiki home](../README.md) › [AI providers](../ai-providers.md) › ChatGPT (subscription)

# ChatGPT (subscription)

| | |
| --- | --- |
| **Shown in Interleaf as** | ChatGPT (subscription) |
| **AI Chat** | ✅ Yes |
| **AI Agent** | ✅ Yes — profile **Codex** |
| **Needs** | The `codex` command-line tool, signed in with your ChatGPT account |
| **Hosted web search** | ❌ No |
| **Session resume in Agent Mode** | ✅ Yes — the only provider that supports it |

This provider uses your **ChatGPT subscription** through the Codex CLI. It is
not an OpenAI API key, and Interleaf will not ask you for one.

---

## Setup

1. **Install the Codex CLI** yourself. Interleaf does not install it and does not
   run installation commands on your behalf. The official documentation is
   linked from the app's **Installation help** action:
   <https://developers.openai.com/codex/cli/>
2. **Sign in with your ChatGPT account** using the CLI's own sign-in flow.
3. In Interleaf, open **Settings ▸ AI Providers** and expand the **Codex** row.
   Detection runs and reports what it found.
4. When the row reads **Ready**, you are done.

From the guided setup wizard, the same row offers a **Sign in with ChatGPT**
action directly.

If the row says **Sign-in required**, Interleaf explains it in chat as:

> Sign in with ChatGPT in Settings to use your subscription for AI Chat.

---

## Using it for AI Chat

Select **ChatGPT (subscription)** from the provider menu in the chat composer,
or make it your default.

The model is listed as **ChatGPT default**. Interleaf does not present a model
menu when a provider publishes only its own default.

### An honest note on how chat runs

Interleaf's chat is meant to be *grounded* — it answers from the context you
attached and cites it. That works best with a provider that can answer without
reaching for tools.

For this provider, Interleaf invokes the CLI over a deliberately constrained,
read-only path: a private empty working directory, approvals disabled, your
personal CLI configuration and rules ignored, a minimal environment, bounded
input/output and time, and an abort if the tool tries to do something outside
that. Those are meaningful constraints, but they are not the same claim as "the
model has no tools at all": a tool surface remains, narrowed rather than
removed. If that distinction matters to you, prefer
[OpenRouter](openrouter.md), [Local server](local-server.md),
[Claude Code](claude-code.md), [Pi](pi.md) or [Omp](omp.md), which Interleaf runs
in tool-free mode.

---

## Using it for AI Agent

The agent profile is **Codex**. It is the most capable agent integration in
Interleaf:

- **Session resume** — after a run finishes you can send a follow-up instruction
  and continue in the same prepared workspace. No other profile supports this.
- **Native Restricted** execution mode is available, using the CLI's own
  workspace-write permission system. Codex is currently the only profile that
  proves the contract Interleaf requires for that mode. Like Active Environment,
  it writes into the directory you selected as the run happens, so there is no
  diff to apply afterwards.
- Structured progress, tool activity and file-change events appear live in the
  run view.
- Model and reasoning-effort selection are available in **Run settings**.

See [AI Agent](../ai-agent.md) for the full workflow.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not installed** | The `codex` binary was not found. Install it, then reopen the provider row. |
| **Sign-in required** | Run the CLI's sign-in flow, then re-check. |
| **Sign-in check failed** | The check itself errored. Confirm the CLI runs from your terminal. |
| Chat stops with a tool-related error | Interleaf aborts if the constrained path is violated. Try a smaller, more specific question, or another provider. |

More: [Help and troubleshooting](../help-and-troubleshooting.md#ai-providers)

---

Related: [AI providers](../ai-providers.md) · [AI Chat](../ai-chat.md) ·
[AI Agent](../ai-agent.md)
