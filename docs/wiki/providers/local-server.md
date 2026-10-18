[Wiki home](../README.md) › [AI providers](../ai-providers.md) › Local server

# Local server (loopback)

| | |
| --- | --- |
| **Shown in Interleaf as** | Local server (loopback) |
| **AI Chat** | ✅ Yes |
| **AI Agent** | ❌ No |
| **Needs** | An inference server already running on this machine |
| **Hosted web search** | ❌ No |

Interleaf's own description: *Ollama or another OpenAI-compatible server on this
machine. Interleaf connects only to a loopback address.*

The panel's lede is *Chat with a model served from this machine over a loopback
connection.*

---

## Setup

You need a server running first — Interleaf does not start, install or manage
one.

1. Start your server. Ollama's default address is `http://127.0.0.1:11434`.
2. In Interleaf, open **Settings ▸ AI Providers** and expand the **Local server
   (loopback)** row.
3. Choose a **Server type**:
   - **Ollama** — *Uses Ollama's OpenAI-compatible API, plus its read-only model
     metadata to read each model's real context window.*
   - **OpenAI-compatible (llama.cpp, LM Studio)** — *Uses only `/v1/models` and
     `/v1/chat/completions`. Context window is unknown over this API, so a
     conservative default is assumed.*
4. Enter the **Server address** and click **Use address** to save it.
5. Click **Check connection**.
6. Pick a **Model**, or leave *Use the first available model*.

> **Save before you check.** The connection check runs against the *stored*
> address, so **Check connection** stays disabled while you have unsaved edits.
> The panel reminds you: *Select "Use address" to save this address before
> checking it.*

The guided setup wizard offers the same panel as **Configure local server**.

---

## What addresses are accepted

Deliberately very few. The field's note says it plainly:

> Only 127.0.0.1 and [::1] are accepted, over http, with no path. Ollama's
> default is http://127.0.0.1:11434.

So:

| Address | Accepted? |
| --- | --- |
| `http://127.0.0.1:11434` | ✅ |
| `http://[::1]:8080` | ✅ |
| `http://localhost:11434` | ❌ — a name, not a literal address |
| `https://127.0.0.1:11434` | ❌ — a loopback server has no meaningful certificate |
| `http://192.168.1.50:11434` | ❌ — another machine |
| `http://127.0.0.1:11434/v1` | ❌ — no path, query or fragment |
| `http://user:pass@127.0.0.1:11434` | ❌ — no credentials in the address |

This is not fussiness for its own sake. A literal IP address is resolved by no
name server, so there is no lookup to poison and no way for "local" to quietly
become somewhere else. `localhost` *is* resolved, and on a misconfigured machine
it can point elsewhere.

If you type something unacceptable, the field tells you exactly why — for
example *Only 127.0.0.1 and [::1] are accepted. Names such as localhost, other
machines, and LAN addresses are not.*

---

## Where your text goes

The panel has a section called **Where your text goes**, and it is worth quoting
in full because it is the one place people assume more than is true:

> Interleaf connects only to a loopback address on this machine, and never to a
> remote host. It cannot control what the server does next: Ollama can route a
> cloud-capable model to Ollama's own servers, and your text would leave this
> machine that way. For guaranteed on-device inference, start Ollama with
> `OLLAMA_NO_CLOUD=1`.

In short: Interleaf guarantees the *socket*, not the destination. If you need a
hard guarantee that nothing leaves the machine, configure that in your server.

---

## Status labels

| Label | Meaning |
| --- | --- |
| **Ready** | The server answered and offers models. |
| **Not reachable** / *No server responded at that address.* | Nothing is listening there. |
| **No models** / *Connected, but the server offers no models.* | The server is up but has nothing loaded. |
| **Checking…** | The check is running. |

Note that this row never says "sign in" — a loopback server has no account.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not reachable** | Confirm the server is running and on the port you entered. |
| **No models** | Pull or load a model in your server, then **Check connection** again. |
| A model you chose disappears from the menu | The server no longer lists it. Interleaf will not silently use a model the server does not have; pick a current one. |
| Answers are slow | That is your server and hardware, not Interleaf. Try a smaller model, or attach less context. |
| Context is cut short | Over the plain OpenAI-compatible API the real context window is unknowable, so a conservative default is assumed. Use the **Ollama** server type if you run Ollama. |

---

Related: [AI providers](../ai-providers.md) · [AI Chat](../ai-chat.md) ·
[OpenRouter](openrouter.md)
