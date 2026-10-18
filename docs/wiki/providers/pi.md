[Wiki home](../README.md) › [AI providers](../ai-providers.md) › Pi

# Pi

| | |
| --- | --- |
| **Shown in Interleaf as** | Pi |
| **AI Chat** | ✅ Yes, in tool-free mode |
| **AI Agent** | ✅ Yes — profile **Pi** |
| **Needs** | The `pi` command-line tool, signed in to a model provider |
| **Hosted web search** | ❌ No |
| **Session resume in Agent Mode** | ❌ No |

Interleaf's own description: *Subscription-backed. Reader Chat runs it in safe
tool-free mode; Agent Mode uses the profile below.*

---

## Setup

1. **Install the Pi CLI** yourself. Interleaf's **Installation help** action
   links to the project's page: <https://github.com/earendil-works/pi>
2. **Sign in to a model provider** through Pi. Pi is a front end for models you
   supply, so it needs its own provider configured before it can answer.
3. In Interleaf, open **Settings ▸ AI Providers** and expand the **Pi** row.

If Pi is installed but no model provider is signed in, chat reports:

> Sign in to a Pi model provider to use Pi for AI Chat.

---

## Models

Pi's model list is **discovered at runtime** from the CLI itself. Interleaf does
not carry a hard-coded catalogue, and a question is never sent against a model
identifier the CLI did not publish. Before discovery has run, you may see the
placeholder **Pi CLI default**.

If the model menu is empty, configure a model provider in Pi and re-check.

---

## Using it for AI Chat

Choose **Pi** in the composer's provider menu. Interleaf runs it in tool-free
mode for chat, so it answers from the context you attached.

---

## Using it for AI Agent

The agent profile is **Pi**. It reports tool activity during a run and supports
model selection, but it does not stream structured file-change events, does not
have a native sandbox of its own, and does not support session resume.

Because it has no native sandbox, use one of Interleaf's isolated execution
modes — see
[AI Agent ▸ Execution environments](../ai-agent.md#execution-environments).

The **Start agent** bar will tell you plainly if the binary is missing:
*Pi is not installed on this machine.*

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not installed** | The `pi` binary was not found. Install it, then reopen the row. |
| **Sign-in status unknown** | Interleaf does check: it lists Pi's models and then runs a bounded `pi auth check --provider <provider> --json --no-refresh` per model provider, exposing only models whose provider answered *ready*. **Unknown** means that probe could not establish readiness — not that no check exists. Confirm the CLI runs and is configured for a model provider from your terminal, then reopen the row to re-run detection. The probe sends no credential and runs no inference. |
| Empty model menu | Sign in to a model provider inside Pi, then re-check the row. |

---

Related: [AI providers](../ai-providers.md) · [Omp](omp.md) ·
[AI Agent](../ai-agent.md)
