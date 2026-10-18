[Wiki home](../README.md) › [AI providers](../ai-providers.md) › OpenRouter

# OpenRouter

| | |
| --- | --- |
| **Shown in Interleaf as** | OpenRouter (row: **OpenRouter API**) |
| **AI Chat** | ✅ Yes |
| **AI Agent** | ❌ No — it is a model API, not an agent |
| **Needs** | An OpenRouter API key |
| **Hosted web search** | ✅ Yes — the only provider that offers it |

Interleaf's own description: *Provides models via your OpenRouter account using
local OS-encrypted key storage.*

This is usually the quickest provider to get working, because it needs no
command-line tool.

---

## Setup

1. Get an API key from your OpenRouter account: <https://openrouter.ai/keys>
2. In Interleaf, open **Settings ▸ AI Providers** and expand the **OpenRouter
   API** row.
3. Paste the key into the **API key** field. New keys look like
   `sk-or-v1-...`, which is what the field's placeholder shows.
4. Choose a **Model**. The default is **OpenRouter Auto** (`openrouter/auto`),
   which lets OpenRouter route your question to a suitable model. The full
   catalogue loads from your account.
5. Click **Test connection** to confirm it works.

The guided setup wizard offers the same thing as **Add OpenRouter key**.

---

## How your key is stored

- The key is encrypted by your operating system's secure storage and held by
  Interleaf's main process.
- It is **never sent back to the app's interface**, never written into settings
  files, the database or logs.
- What you see afterwards is a masked chip plus the word **Saved**.
- **Remove** deletes it.

If secure storage is unavailable on your system, Interleaf refuses to store the
key at all rather than saving it in plain text.

### If you see "Unreadable" / "Saved key unreadable"

A key is stored but could not be decrypted, so it cannot be used, and Interleaf
will not present it as ready. The panel says:

> This saved key could not be read from encrypted storage, so it cannot be used.
> Type a new key in the field below to restore access, or remove it.

Type a fresh key into the field, or click **Remove**.

---

## Using it for AI Chat

Choose **OpenRouter** in the composer's provider menu. Because OpenRouter
publishes many models, a **model menu** appears next to the provider menu — pick
whichever you want for this conversation.

### Web search

OpenRouter is the only provider where the composer shows a **Web search**
toggle. Turn it on for a single question and the model may search the web while
answering; results appear under **Web sources** below the answer, and up to ten
results are used.

This is a per-question setting, not a permanent one. It is not offered for any
other provider, because no other provider in Interleaf has hosted search.

---

## Cost

OpenRouter bills your account per request. Interleaf never calls it on its own:
a request happens only when you send a message. Detection and connection
testing do not run a model.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| **Not configured** | No key saved yet. Paste one into the panel. |
| **Saved key unreadable** | See above — enter a new key or remove the stored one. |
| Model list fails to load | Use **Retry** next to the Model field. |
| *This persisted model is no longer in the current catalog* | The model you had selected has gone. Pick a current one from the menu. |
| **Test connection** fails | Check the key is current and your account is in good standing. |

---

Related: [AI providers](../ai-providers.md) ·
[AI Chat](../ai-chat.md#web-search) ·
[Local server](local-server.md)
