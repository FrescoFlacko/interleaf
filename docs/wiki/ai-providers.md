[Wiki home](README.md) › AI providers

# AI providers

Interleaf has two separate AI features, and **they do not use the same set of
providers**:

- **AI Chat** (also called *Reader Chat*) answers questions about the document
  you are reading. See [AI Chat](ai-chat.md).
- **AI Agent** (also called *Agent Mode*) runs a coding-agent command-line tool
  against a folder on your machine. See [AI Agent](ai-agent.md).

Some providers do one, some do the other, and some do both. This page is the
map.

**On this page**

- [The capability matrix](#the-capability-matrix)
- [How to read the matrix](#how-to-read-the-matrix)
- [How to connect a provider](#how-to-connect-a-provider)
- [Status labels you will see](#status-labels-you-will-see)
- [Choosing defaults](#choosing-defaults)
- [What leaves your machine](#what-leaves-your-machine)
- [Per-provider guides](#per-provider-guides)

---

## The capability matrix

| Provider | AI Chat | AI Agent | How you connect | Hosted web search |
| --- | --- | --- | --- | --- |
| **[ChatGPT (subscription)](providers/chatgpt-subscription.md)** | ✅ | ✅ | Install the `codex` CLI and sign in with ChatGPT | ❌ |
| **[Claude Code](providers/claude-code.md)** | ✅ | ✅ | Install the `claude` CLI and sign in | ❌ |
| **[Pi](providers/pi.md)** | ✅ | ✅ | Install the `pi` CLI and sign in to a model provider | ❌ |
| **[Omp](providers/omp.md)** | ✅ | ❌ | Install the `omp` CLI and sign in to a model provider | ❌ |
| **[OpenRouter](providers/openrouter.md)** | ✅ | ❌ | Paste an API key in Settings | ✅ |
| **[Local server (loopback)](providers/local-server.md)** | ✅ | ❌ | Point Interleaf at a server running on `127.0.0.1` | ❌ |
| **[Antigravity](providers/antigravity.md)** | ❌ | ✅ | Install the `agy` CLI | ❌ |
| **[OpenCode](providers/agent-only-clis.md)** | ❌ | ✅ | Install the `opencode` CLI | ❌ |

---

## How to read the matrix

**"AI Chat ✅"** means Interleaf can ask that provider a question about your
document and get a grounded, cited answer back.

**"AI Chat ❌"** covers two different situations:

- **Antigravity** is not offered for chat *as things stand*. Interleaf reports:
  *This Antigravity CLI version has no verified tool-free chat mode; it remains
  available for Agent Mode only.* Chat needs a provider that can answer without
  reaching for tools, and this CLI version gives Interleaf no verified way to
  ask for that. Read it as a current limitation of the integration and the CLI
  version, not as a permanent product decision.
- **OpenCode** has no chat integration; it is an agent profile only.

**"AI Agent ❌"** means there is no agent to run:

- **OpenRouter** and **Local server** are model APIs, not agents — there is no
  command-line agent to run. **Omp** is deliberately Reader Chat only:
  *Interleaf runs it in tool-free JSON mode and gives it no Agent Mode profile.*

GitHub Copilot is not in the matrix because it is not offered at all: this
integration cannot run it for unattended Agent Mode, so installing the `copilot`
CLI does not add it and no setting turns it on. See
[OpenCode ▸ GitHub Copilot](providers/agent-only-clis.md#github-copilot).

**"Hosted web search"** is a per-question toggle that lets the model search the
web as part of answering. Only **OpenRouter** supports it. Every command-line
provider and the local server do not, and the toggle is not offered for them.

One more agent-only difference worth knowing before you pick: **resuming a
finished agent session with a follow-up instruction is supported by Codex only.**
Other profiles finish and stop. See
[AI Agent ▸ Resuming](ai-agent.md#resuming-a-session).

---

## How to connect a provider

All provider setup lives in one place: **Settings ▸ AI Providers**. The rows
appear in a fixed order — OpenRouter, Local server, then each command-line
integration, then Omp — whether or not anything is installed.

Click a row to expand its panel.

There are three shapes of setup:

1. **An API key** (OpenRouter). Paste it into the panel. Interleaf stores it
   encrypted through your operating system's secure storage and never shows it
   back to you.
2. **A loopback address** (Local server). Tell Interleaf which port your server
   is on.
3. **A command-line tool** (everything else). Install the tool yourself, sign in
   using *that tool's own* documented flow, then come back to Interleaf and let
   it detect the result.

> **Interleaf never asks for your provider password**, and never reads browser
> cookies. It uses each tool's own supported sign-in. A ChatGPT or Claude
> *subscription* is not the same thing as an OpenAI or Anthropic *API key*, and
> Interleaf does not ask you to convert one into the other.

The guided setup wizard (**Settings ▸ General ▸ Run guided setup**) walks through
the same thing with **Installation help** links to each tool's official
documentation.

---

## Status labels you will see

Detection is live, and Interleaf reports exactly what it found — *installed*,
*authenticated* and *chat-capable* are three different things.

| Label | Meaning |
| --- | --- |
| **Ready** | Usable right now. |
| **Checking…** | Detection is still running. |
| **Not installed** | The command-line tool was not found on this machine. |
| **Sign-in required** | The tool is installed but not signed in. |
| **Sign-in status unknown** | Installed, but the tool offers no way to verify sign-in. Try it and see. |
| **Sign-in check failed** | The check itself errored. |
| **Agent Mode only** | The integration exists, but not for chat. |
| **Not configured** | OpenRouter, with no API key saved. |
| **Saved key unreadable** | A stored OpenRouter key could not be decrypted, so it cannot be used. Enter a new one or remove it. |
| **Not reachable** | Nothing answered at the local server address. |
| **No models** | The local server answered but offers no models. |

In the guided setup wizard the same states read slightly differently — *Ready for
Reader Chat*, *Ready for Agent Mode*, *Installed — sign-in not verified*, *API
key not added*, *No local server responding*, *Connected — no models listed*,
*Could not verify*, *Reader Chat only*, *Agent Mode only*, *Unavailable*.

Use **Check again** (wizard) or reopen the provider row (Settings) to re-run
detection after you install or sign in to something.

---

## Choosing defaults

You can nominate one default for each feature, independently:

- A **Reader Chat** default provider (and optionally a model).
- An **Agent Mode** default profile.

Set them in the guided setup wizard (*Use one of these for Reader Chat by
default?* / *…for Agent Mode by default?*), or per provider in Settings.

Two things worth knowing:

- Defaults apply to **new** conversations and **new** agent drafts only.
  Anything already open keeps what it was created with.
- Choosing a default **grants nothing and starts nothing**. An agent run still
  asks for its own permission when you start it. Remember that the agent's
  execution environment decides where work is directed, not what a third-party
  CLI is capable of doing — see
  [What "isolated" does and does not mean](ai-agent.md#what-isolated-does-and-does-not-mean).

You can always override the provider for an individual conversation from the
provider menu in the chat composer.

---

## What leaves your machine

Worth being precise about, because it differs by provider.

| Provider type | Where your text goes |
| --- | --- |
| OpenRouter | Over the internet to OpenRouter, and on to whichever model you selected. |
| ChatGPT / Claude Code / Pi / Omp / Antigravity / OpenCode | To a program on your machine, which sends it to that vendor's service under your own account. |
| Local server | Over a loopback connection to a server on your machine — see the caveat below. |

The local server case has a genuine subtlety, and Interleaf states it plainly in
the panel under **Where your text goes**: Interleaf guarantees only that it
connects to a loopback address and never to a remote host. It cannot control what
the server does next — Ollama, for instance, can route a cloud-capable model to
Ollama's own servers. For guaranteed on-device inference, start Ollama with
`OLLAMA_NO_CLOUD=1`.

**Document and prompt content** is sent only when you ask a question or start an
agent run. That is the claim worth relying on — it is narrower than "Interleaf
makes no network requests", which would not be true:

- Detection and sign-in checks run the installed CLI, and some of those checks
  talk to the vendor over the network on their own (listing Antigravity's model
  catalogue with `agy models`, for example, refreshes that catalogue over the
  network). They are listings and auth checks, not inference, and they do not
  send your document.
- Asking a configured local server for its model list contacts that server.
- Importing a web article deliberately fetches the page you gave Interleaf.
- A command-line tool you installed is a separate program with its own network
  behaviour, which Interleaf does not control.

Your documents, annotations, reading positions, chat history and agent session
records stay on your machine; nothing uploads your library on its own.

---

## Per-provider guides

- [ChatGPT (subscription)](providers/chatgpt-subscription.md) — Chat + Agent
- [Claude Code](providers/claude-code.md) — Chat + Agent
- [Pi](providers/pi.md) — Chat + Agent
- [Omp](providers/omp.md) — Chat only
- [OpenRouter](providers/openrouter.md) — Chat only, with web search
- [Local server (loopback)](providers/local-server.md) — Chat only
- [Antigravity](providers/antigravity.md) — Agent only
- [OpenCode](providers/agent-only-clis.md) — Agent only (also explains why
  GitHub Copilot is not offered)

---

Next: [AI Chat](ai-chat.md) · [AI Agent](ai-agent.md) ·
[Help and troubleshooting](help-and-troubleshooting.md#ai-providers)
