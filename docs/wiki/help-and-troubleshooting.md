[Wiki home](README.md) › Help and troubleshooting

# Help and troubleshooting

Symptom first, fix second. If you would rather read a short answer to a general
question, try the [FAQ](faq.md).

---

## On this page

- [Installing and running](#installing-and-running)
- [Importing and opening](#importing-and-opening)
- [Reading](#reading)
- [Highlights and notes](#highlights-and-notes)
- [Search](#search)
- [AI providers](#ai-providers)
- [AI Chat](#ai-chat)
- [AI Agent](#ai-agent)
- [Still stuck](#still-stuck)

---

## Installing and running

| Symptom | What to try |
| --- | --- |
| `npm run dev` fails immediately | Check your Node.js version against [Installation ▸ Requirements](installation.md#requirements), then run `npm install` again. |
| You are looking for a download link | macOS and Linux installers are releases of the public `FrescoFlacko/interleaf-releases` repository, also linked from [interleaf.ca](https://interleaf.ca/). Windows installers are not published: install a build from someone you trust, run from source, or build a package yourself. See [Installation](installation.md#what-is-available-today). |
| You have a Windows installer and want a normal desktop app | See [Installation ▸ Install from a Windows .exe](installation.md#install-from-a-windows-exe). After that it launches from the Start menu — no terminal, no Node.js. |
| An installer or app warns that the publisher is unidentified | A build made without a signing certificate is unsigned, and this repository provides none, so the warning is accurate. Continue only if you trust where the file came from. See [Installation ▸ What is available today](installation.md#what-is-available-today). |
| The app does not start after a build | Try `npm run dev` first. If that works, the problem is packaging, not the app. |
| You want to remove Interleaf and its data | See [Installation ▸ Updating and uninstalling](installation.md#updating-and-uninstalling). |

---

## Importing and opening

| Symptom | What to try |
| --- | --- |
| *Unsupported file extension: '.xyz'. Supported extensions are .pdf, .epub, .mobi, .azw, .azw3, .docx, .pptx, .md, .markdown.* | Interleaf reads those nine extensions and nothing else. Convert the file first. |
| *This document appears to be DRM-protected and cannot be opened by Interleaf.* | The book is protected. Interleaf detects DRM and stops; it does not remove it. Use a DRM-free copy. |
| *"Title" is already in your library.* | You imported it before. Open the existing copy. |
| A password-protected PDF fails to open | Encrypted PDFs are reported as a reader error, and no password is stored. Remove the password in another tool first. |
| A web article import is refused | The address must be a public `http://` or `https://` page. Pages behind a login or a paywall cannot be captured. See [Adding documents ▸ Save a web article](adding-documents.md#save-a-web-article). |
| A captured web article is missing its pictures | Interleaf keeps a bounded number of images per article and tells you when it kept fewer than the page had. See [Markdown and saved web articles](formats/markdown-and-web-articles.md). |
| A document card shows **Missing** | The original file moved or was deleted, and this document was linked in place rather than copied. See [Adding documents ▸ Managed copy versus link in place](adding-documents.md#managed-copy-versus-link-in-place). |
| A document card shows **Changed** | The linked file on disk is not the one that was imported. Highlights may no longer line up. |
| A document card shows **Checking…** | Interleaf is still verifying the linked file. Give it a moment. |
| Import seems to finish but search finds nothing yet | Text extraction and indexing continue in the background after the card appears. |

---

## Reading

| Symptom | What to try |
| --- | --- |
| Line spacing or margin settings do nothing | They apply to reflowable formats only. In a PDF the page geometry is fixed — the toolbar says so: *Line spacing applies to reflowable formats.* |
| A PDF looks small or clipped | Use the zoom menu: **Fit Width**, **Fit Page**, or a fixed percentage. `⌘ 0` / `Ctrl + 0` resets it. |
| No table of contents | Not every document has one. Press `T`, and if the outline is empty the document itself supplied none. |
| Audio, video or an embedded widget in the document does nothing | That is permanent and deliberate. Interleaf never plays, renders, executes or extracts interactive document media in any format. Inert text and captions are kept, and ordinary still images follow each format's own rules. |
| A DOCX page number does not match Word's | DOCX has no fixed pages; Interleaf derives page hints. See [DOCX](formats/docx.md). |
| The window feels cramped | `F11` enters Focus Reading Mode; `Esc` leaves it. |

---

## Highlights and notes

| Symptom | What to try |
| --- | --- |
| *Highlights and notes are limited to 50 pages. Use Ask AI for large ranges.* | The selection is too large to anchor reliably. Highlight a smaller passage, or send the big one to AI Chat instead. |
| The same message naming 100 blocks, 100 paragraphs or 256,000 characters | Same cause, different format's unit. |
| *Highlights and notes could not be mapped to document segments deterministically. Use Ask AI for this selection.* | Interleaf could not anchor that selection precisely, and will not store an annotation it cannot place. |
| A highlight has lost its place | Use **Re-attach** in the annotations browser. See [Highlights and notes ▸ When a highlight loses its place](highlights-and-notes.md#when-a-highlight-loses-its-place). |
| You cannot find a note again | Open **Annotations** (`⌘ Shift + N` / `Ctrl + Shift + N`) and filter or sort there. |

---

## Search

| Symptom | What to try |
| --- | --- |
| Searching the library finds nothing inside a document | The library sidebar's field searches titles and metadata. Use the companion panel's **Search** tab (`⌘ F` / `Ctrl + F`) to search inside documents. |
| A newly imported document is not searchable yet | Indexing runs in the background after import. |

---

## AI providers

| Symptom | What to try |
| --- | --- |
| **No AI Provider Ready** | Nothing is connected yet. Select **Configure Providers** and set one up — see [AI providers](ai-providers.md#how-to-connect-a-provider). |
| *Could not check AI providers* | Discovery failed. Select **Check Again**, or **Open Settings**. |
| **Not installed** on a provider row | The command-line tool that provider needs was not found on this machine. Install it, then reopen the row. |
| **Sign-in status unknown** | That CLI publishes no check Interleaf can verify. Asking a question is the real test. |
| **Agent Mode only** | That provider has no Reader Chat integration. Antigravity and OpenCode carry this label. |
| Antigravity is missing from the chat provider menu | Expected with this CLI version: *This Antigravity CLI version has no verified tool-free chat mode; it remains available for Agent Mode only.* Nothing to configure. See [Antigravity](providers/antigravity.md). |
| A local server shows **Not reachable** | Nothing is listening at the address you saved. Start the server, confirm the port. |
| A local server shows **No models** | The server is up but has nothing loaded. Pull or load a model, then **Check connection**. |
| **Check connection** is greyed out | You have unsaved edits. Select **Use address** first — the check runs against the stored address. |
| A loopback address is refused | Only `127.0.0.1` and `[::1]` are accepted, over `http`, with no path. `localhost` is a name, not a literal address. See [Local server](providers/local-server.md#what-addresses-are-accepted). |
| An OpenRouter model disappeared from the menu | Interleaf will not send a request against a model the provider no longer lists. Pick a current one. |

---

## AI Chat

| Symptom | What to try |
| --- | --- |
| The composer is disabled | Read its placeholder — it names the reason. See [AI Chat ▸ Asking a question](ai-chat.md#asking-a-question). |
| *This conversation is archived. Create a new session to ask questions.* | Archived threads are read-only. Start a new conversation. |
| **Generation failed** | Send again. If it repeats, check that provider's row in **Settings ▸ AI Providers**. |
| **Stopped** | You pressed **Stop**. The partial answer is kept. |
| **Context partially included:** … | The turn could not carry everything you attached. Attach a narrower range and ask again — see [AI Chat ▸ Context notices](ai-chat.md#context-notices). |
| Answers are vague or generic | Attach a selection or a page range instead of the whole document. |
| A context chip appeared that you did not add | You sent a question with the context bar empty, so Interleaf attached a bounded window around your reading position. Remove it and pin what you want instead. See [AI Chat ▸ What gets sent when you attach nothing](ai-chat.md#what-gets-sent-when-you-attach-nothing). |
| A **Web sources** entry will not open when you select it | Those references are inert text, not links. Read the address and open it yourself. |
| A citation is plain text instead of a clickable chip | It does not match any source that was attached to that turn. Treat it as unverified. |
| There is no **Web search** control | Only OpenRouter declares hosted web search. See [AI Chat ▸ Web search](ai-chat.md#web-search). |
| *Context usage statistics are unavailable for this conversation.* | No request has been packed yet for this conversation. The figures return after the next message. |
| Your pinned context vanished after **Clean Context** | Expected, and stated in the confirmation. Re-attach what still matters. |
| *Choose no more than 250 pages at a time.* | Split the range. |

---

## AI Agent

| Symptom | What to try |
| --- | --- |
| **Start agent** is disabled | The status line beside it names the first unmet precondition. See [AI Agent ▸ When Start agent is blocked](ai-agent.md#when-start-agent-is-blocked). |
| *&lt;Profile&gt; is not installed on this machine.* | That CLI is not on this machine. Install it — see [AI providers](ai-providers.md). |
| *GitHub Copilot CLI is unavailable for unattended Agent Mode.* | Copilot is no longer offered, but a conversation or setting saved by an older version may still name it. This integration refuses Copilot for unattended runs, and there is no setting that changes it. Choose another agent. See [OpenCode ▸ GitHub Copilot](providers/agent-only-clis.md#github-copilot). |
| *Choose a working directory to start.* | Select **Choose…** in **Run settings**. |
| **Native Restricted** is unavailable for your agent | Interleaf only offers it to a CLI whose own sandbox it can verify, and Codex is currently the only one that passes. Use an isolated mode. See [Antigravity](providers/antigravity.md#using-it-for-ai-agent). |
| **Container Sandbox** is not in the menu | Expected. No verified bounded container executor exists, so the mode is not offered, never silently falls back, and installing Docker or Podman does not add it. See [AI Agent ▸ Execution environments](ai-agent.md#execution-environments). |
| A native dialog appears before the run starts | You selected **Native Restricted** or **Active Environment**. Those write into your selected folder as the run happens, so each one is confirmed outside the app UI, every time. |
| **Apply Changes** is missing | Applying is not available for this environment; the card states the reason just above the actions. After a direct-workspace run there is nothing to apply — the changes already happened. |
| **Active workspace modified directly.** | You ran in a direct-workspace mode. Your real folder was written to. |
| The activity list is nearly empty | Not every CLI streams detail. Pi reports tool activity but no file changes; Codex and Claude Code report the most. |
| *No test results reported.* | The agent reported no tests. It does not mean tests passed. |
| There is no **Resume** composer | Only Codex supports session resume. |
| *Resume is unavailable because this environment was already applied.* | Start a new session. |
| A saved working directory reads **Unavailable saved directory** | The folder moved or was deleted. Remove the entry. |

---

## Still stuck

- **Settings ▸ Advanced** has *Record diagnostic debug logging*, and the
  Settings dialog has **Export Debug Log** at the bottom. Turn logging on,
  reproduce the problem, then export.
- Check the [FAQ](faq.md) for whether the behaviour is intentional.
- If you are comfortable with the code, the technical documents live one
  directory up: [Architecture](../ARCHITECTURE.md),
  [Security](../SECURITY.md), [AI Architecture](../AI_ARCHITECTURE.md),
  [Agent Runtime](../AGENT_RUNTIME.md),
  [Document Formats](../DOCUMENT_FORMATS.md).

---

Related: [FAQ](faq.md) · [Wiki home](README.md)
