[Wiki home](README.md) › FAQ

# Frequently asked questions

Short answers. Each links to the page with the long one.

---

## On this page

- [Getting it](#getting-it)
- [Documents](#documents)
- [Reading and annotating](#reading-and-annotating)
- [AI in general](#ai-in-general)
- [AI Chat](#ai-chat)
- [AI Agent](#ai-agent)
- [Privacy and data](#privacy-and-data)

---

## Getting it

**Where do I download Interleaf?**
From the public [`FrescoFlacko/interleaf-releases`](https://github.com/FrescoFlacko/interleaf-releases/releases)
repository, or via the download buttons on [interleaf.ca](https://interleaf.ca/).
Releases include macOS (DMG and ZIP, signed and notarized) and Linux (AppImage,
`.deb` and pacman) packages. Windows has an NSIS installer you can build, but
none is published; install a build from someone you trust, run from source, or
build a package yourself. See [Installation](installation.md#what-is-available-today).

**Someone gave me a Windows `.exe`. Can I just install it?**
Yes — pick the build matching your PC, run the wizard, choose an installation
folder, and afterwards launch it from the Start menu with no terminal and no
Node.js. Only install one from a source you trust; an unsigned build will
trigger a SmartScreen publisher warning. See
[Installation ▸ Install from a Windows .exe](installation.md#install-from-a-windows-exe).

**Can I build a Windows `.exe` myself?**
Yes: `npm run package:win` produces an NSIS installer in `release/`, with
`--publish never`. See
[Installation ▸ Build a Windows .exe installer](installation.md#build-a-windows-exe-installer).

**Does it run on macOS, Windows and Linux?**
Yes, from source on all three. Packages can be built for all three.

**Is it free?**
The app itself makes no inference calls of its own. If you connect a paid AI
provider, that provider bills you on its own terms.

---

## Documents

**Which formats can it read?**
PDF, EPUB, MOBI/AZW/AZW3, DOCX, PPTX and Markdown, plus web articles captured as
Markdown. See [Document formats](formats/README.md).

**Can it open my Kindle books?**
Only DRM-free `.mobi`, `.azw` and `.azw3` files. DRM-protected books are
detected and refused; Interleaf does not remove DRM.

**Can I edit a PDF or a Word document?**
No. Interleaf is a reader and an annotator. Your original file is never
modified.

**Why won't the audio/video in my document play?**
Because Interleaf never plays, renders, executes or extracts interactive media
that a document supplies — in any format, permanently. Inert text and captions
are kept, and ordinary still images follow each format's own rules. This is a
deliberate safety boundary, not a gap.

**Does importing move my file?**
Only if you choose a managed copy. Linking in place leaves the file where it is
— and means Interleaf notices if it later moves or changes. See
[Adding documents](adding-documents.md#managed-copy-versus-link-in-place).

**Can I save a web page?**
Yes — a public `http://` or `https://` page is captured as a Markdown snapshot.
See [Adding documents ▸ Save a web article](adding-documents.md#save-a-web-article).

---

## Reading and annotating

**How many highlight colours are there?**
Five. See [Highlights and notes](highlights-and-notes.md).

**Why can't I highlight this huge selection?**
There are per-format limits so an annotation can always be anchored back to an
exact place. The message tells you the limit and suggests **Ask AI** instead.

**Do my highlights sync anywhere?**
No. Everything is stored locally.

**Are there keyboard shortcuts?**
Yes, and only real ones — Interleaf does not advertise bindings it has not
implemented. See [Keyboard shortcuts](keyboard-shortcuts.md).

---

## AI in general

**Do I have to use the AI features?**
No. Reading, annotating and searching work entirely offline. Nothing AI-related
runs until you connect a provider yourself.

**Which providers can I use?**
Seven for chat and agent work between them. Some do both, some only one. The
[capability matrix](ai-providers.md#the-capability-matrix) is the single
authoritative table.

**What is the difference between AI Chat and AI Agent?**
Chat answers questions about the document you are reading; Interleaf gives it no
working directory and no way to change your files. The agent runs a coding CLI
against a folder on your machine and writes files — in the default isolated
modes, after you review a diff and apply it. See [AI Chat](ai-chat.md) and
[AI Agent](ai-agent.md).

**Does Interleaf install the AI tools for me?**
No. You install and sign in to each CLI yourself; Interleaf detects whether it
is present and says so.

**Why is a provider I installed shown as Not installed?**
Interleaf did not find its executable. Install it, then reopen the row in
**Settings ▸ AI Providers**.

---

## AI Chat

**Does the AI read my whole document automatically?**
No — never the whole document unless you toggle **Entire document** yourself.
But it is not true that it reads *only* what you attached: if you send a question
with the context bar empty, Interleaf attaches a bounded window around your
current reading position first (ten PDF pages either side of the page you are
on, or the current chunk in a reflowable format) and sends that. The attachment
shows up as a chip in the context bar, so you can see it and remove it. When you
have pinned context, that is exactly what is used and nothing is added to it.
See [AI Chat ▸ What gets sent when you attach nothing](ai-chat.md#what-gets-sent-when-you-attach-nothing).

**Is AI Agent the same?**
No — the opposite. The agent sends nothing from your document unless you attach
it explicitly.

**Can I trust the citations?**
A citation becomes a clickable chip only when it matches a source that was
actually attached to that turn. A marker the model invented stays as plain,
unclickable text.

**Why did it only use part of what I attached?**
Model context windows are finite. When a turn carried less than you attached,
the answer is followed by a **Context partially included:** notice with the
exact numbers. See [AI Chat ▸ Context notices](ai-chat.md#context-notices).

**Can the AI search the web?**
Only with OpenRouter, only when you turn on **Web search** for that specific
turn. The **Web sources** listed under such an answer are shown as inert text,
not clickable links. See [AI Chat ▸ Web search](ai-chat.md#web-search).

**What does Clean Context do?**
It asks the provider to summarise the conversation so far and uses that summary
in place of the earlier turns. Your messages stay visible, but your attached
context is removed. See [AI Chat ▸ Clean Context](ai-chat.md#clean-context).

**Are conversations saved?**
Yes, locally, per document. They appear under **Conversations**.

---

## AI Agent

**Will the agent modify my project?**
In the default mode, not until you say so. **Auto-Isolated** runs it in a
temporary git worktree or a sandbox copy, and its work reaches your folder when
you review the diff and select **Apply Changes**. That is a property of the
isolated modes, not of every run — and workspace isolation is not an
operating-system boundary around the CLI itself. See
[What "isolated" does and does not mean](ai-agent.md#what-isolated-does-and-does-not-mean).

**When *does* it write directly to my folder?**
In **Native Restricted** or **Active Environment**. Those write into the
directory you selected as the run happens — there is no diff and no **Apply
Changes** step — which is why each one requires a native confirmation dialog
every time and neither can be saved as a default. See
[AI Agent ▸ Execution environments](ai-agent.md#execution-environments).

**Where is Container Sandbox?**
Not offered. No verified rootless bounded executor exists, so the mode fails
closed rather than pretending to isolate. It never silently degrades to a weaker
mode.

**Can I continue a finished run?**
With Codex, yes — a follow-up composer resumes in the same workspace. No other
built-in profile declares session resume.

**Can the document tell the agent what to do?**
No. An attached passage is labelled *Attached as untrusted reference*: material
to read, never instructions to obey.

**Why is the activity list so sparse?**
Detail depends on the CLI. Codex, Claude Code, Antigravity and OpenCode stream
structured output, tool activity and file changes; Pi reports tool activity but
no file-change events.

**Why can't I use GitHub Copilot as the agent?**
This integration cannot run it for unattended Agent Mode, so it is not offered.
Installing the CLI does not change it.
See [OpenCode ▸ GitHub Copilot](providers/agent-only-clis.md#github-copilot).

---

## Privacy and data

**Where is my data stored?**
Locally on your machine — documents, highlights, notes and conversations. See
[Installation ▸ Where Interleaf keeps your data](installation.md#where-interleaf-keeps-your-data).

**What leaves my machine?**
Document and prompt content only when you send it to an AI provider (plus
detection, model-listing and web-article fetches, which carry no document
content — see the next-but-one answer). Each provider guide
says what that means in its case; the summary is in
[AI providers ▸ What leaves your machine](ai-providers.md#what-leaves-your-machine).

**Is a local server really local?**
Interleaf connects only to a loopback address and never to a remote host. It
cannot control what your server then does — Ollama, for instance, can route a
cloud-capable model to its own servers. For guaranteed on-device inference,
configure that in the server. See [Local server](providers/local-server.md#where-your-text-goes).

**Where are my API keys kept?**
An OpenRouter API key is in plaintext only while you type it, then encrypted
with Electron's `safeStorage`, backed by your operating system's keychain.
Stored keys are never returned to the interface, never intentionally logged,
never placed in prompts and never written to the settings database. CLI
providers keep their own sign-in; Interleaf never asks you for a password or a
browser cookie.

**Does Interleaf upload my library on its own?**
No. Interleaf's own privacy policy — readable in the app under **Settings ▸
Privacy** — puts it plainly: imported files, notes, highlights, conversations,
settings and search indexes stay on your computer, and your content leaves it
only when you send a request to a provider you chose, or when you export
something yourself.

**So Interleaf makes no network requests until I ask a question?**
That stronger claim is not true, and the distinction is worth knowing. What is
scoped to your request is **document and prompt content**. Other traffic can
happen without any inference: provider detection and sign-in checks run the
installed CLI, and some of those checks contact the vendor themselves (listing
Antigravity's models with `agy models` refreshes that catalogue over the
network); asking a configured local server for its model list contacts that
server; and importing a web article deliberately fetches the page you gave it.
A CLI you installed is also its own program with its own network behaviour. See
[AI providers ▸ What leaves your machine](ai-providers.md#what-leaves-your-machine).

**What ends up in the logs?**
Interleaf's diagnostic logs are bounded and redacted, and exclude document
bodies, prompts, context packets, credentials and raw agent output streams.
Agent session history is separate: a bounded, redacted record of each run is
kept locally so you can review what happened.

**Are isolated execution modes a real sandbox?**
Not in the operating-system sense. An isolated worktree or copy changes where
the agent is started and where its ordinary work lands, so it does not touch
your active project until you apply a diff. It is not a container and not an OS
boundary: the CLI runs under your own user account and can read **and write**
anywhere that account can, especially if it was configured with a
permission-bypass flag of its own. Run agent tools you trust. The app says the
same in **Settings ▸ Privacy**.

---

Related: [Help and troubleshooting](help-and-troubleshooting.md) ·
[Wiki home](README.md)
