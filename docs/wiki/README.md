# Interleaf Wiki

**Read. Think. Build.**

Interleaf is a local-first desktop reader for PDF, EPUB, MOBI/Kindle, Word
(DOCX), PowerPoint (PPTX) and Markdown documents. You can highlight and
annotate, search inside the document you are reading, ask an AI about the page,
and hand a task to a coding-agent CLI that runs on your own machine.

Reading, annotating and searching work completely offline. AI features are
optional and only run when you connect a provider yourself.

![The Interleaf reader showing a PDF page with highlights, and the Annotations tab listing them in the companion panel](../../website/assets/screens/reader-annotations-1600.webp)
*Reading an openly licensed textbook with demo highlights and a note.*

---

## Start here

| If you want to… | Go to |
| --- | --- |
| See what Interleaf does and get reading in ten minutes | [Quick start](quick-start.md) |
| Install or build the app | [Installation](installation.md) |
| Learn the windows, panels and buttons | [App navigation](navigation.md) |
| Add books, papers or web articles | [Adding documents](adding-documents.md) |
| Know how your file will look and behave | [Document formats](formats/README.md) |
| Highlight, take notes and find them again | [Highlights and notes](highlights-and-notes.md) |
| Connect an AI provider | [AI providers](ai-providers.md) |
| Ask questions about the document you are reading | [AI Chat](ai-chat.md) |
| Give a coding task to an agent CLI | [AI Agent](ai-agent.md) |
| Fix a problem | [Help and troubleshooting](help-and-troubleshooting.md) |

---

## Full table of contents

### Getting started

- **[Quick start](quick-start.md)** — first launch, guided setup, importing your
  first document, your first highlight and your first question.
- **[Installation](installation.md)** — where downloads will come from (the
  public release repository, which has no release yet), installing a build you trust, running from
  source on macOS, Windows and Linux, and building a package yourself.
- **[App navigation](navigation.md)** — the library sidebar, the header toolbar,
  the reader, the companion panel and the Settings dialog.
- **[Keyboard shortcuts](keyboard-shortcuts.md)** — every shortcut that actually
  works, in macOS and Windows/Linux notation.

### Your library

- **[Adding documents](adding-documents.md)** — opening a file without
  importing it, importing files, drag and drop,
  managed copies versus links in place, saving a web article, folders, search
  and sorting.
- **[Document formats](formats/README.md)** — the format overview table, plus a
  page per format:
  - [PDF](formats/pdf.md)
  - [EPUB](formats/epub.md)
  - [MOBI, AZW and AZW3 (Kindle)](formats/mobi-kindle.md)
  - [DOCX (Word)](formats/docx.md)
  - [PPTX (PowerPoint)](formats/pptx.md)
  - [Markdown and saved web articles](formats/markdown-and-web-articles.md)

### Reading

- **[Reading a document](reading.md)** — page navigation, the table of contents,
  display settings, palettes, zoom, Focus Reading Mode and full-text search.
- **[Highlights and notes](highlights-and-notes.md)** — the five highlight
  colours, highlight notes, location notes, bookmarks and the Annotations
  browser.

### AI

- **[AI providers](ai-providers.md)** — the capability matrix (which providers
  answer Chat, which run the Agent), how to connect each one, and what leaves
  your machine.
  - [ChatGPT (subscription)](providers/chatgpt-subscription.md)
  - [Claude Code](providers/claude-code.md)
  - [OpenRouter](providers/openrouter.md)
  - [Local server (loopback)](providers/local-server.md)
  - [Pi](providers/pi.md)
  - [Omp](providers/omp.md)
  - [Antigravity](providers/antigravity.md)
  - [OpenCode](providers/agent-only-clis.md)
- **[AI Chat](ai-chat.md)** — attaching context, citations, models, web search,
  the context budget, conversation history and Clean Context.
- **[AI Agent](ai-agent.md)** — choosing a working directory, execution modes,
  starting and stopping a run, reviewing the diff, applying or discarding
  changes, and resuming a session.

### Help

- **[Help and troubleshooting](help-and-troubleshooting.md)** — symptom-by-symptom
  fixes for imports, readers, providers, chat and agent runs.
- **[FAQ](faq.md)** — short answers to the questions people ask most.

---

## Things Interleaf deliberately does not do

Permanent design decisions, not missing features. Knowing them up front saves a
lot of searching.

- **Interactive document media is never played, rendered or extracted.** Audio,
  video, animations, executable embeds, frames, forms and document-supplied
  canvas programs are not exposed by any reader, in any format. Inert text and
  captions are kept, and ordinary still images follow each format's own rules.
  Your original file is not altered.
- **DRM-protected books cannot be opened.** Interleaf detects DRM and refuses
  the document rather than attempting to remove protection.
- **There is no editing of PDFs or Word documents.** Interleaf is a reader and
  an annotator.

## Things that are unavailable today

Different in kind from the list above: these reflect the current state of the
implementation, the integrations or the CLIs they depend on, rather than a
permanent product invariant.

- **Container Sandbox is not offered as an agent execution mode.** No verified
  rootless bounded executor exists, so the mode is withheld and never silently
  falls back to a less isolated one. See
  [AI Agent](ai-agent.md#execution-environments).
- **GitHub Copilot is not offered.** This integration cannot run it for
  unattended Agent Mode, so it is not listed regardless of whether the CLI is
  installed. See [OpenCode ▸ GitHub Copilot](providers/agent-only-clis.md#github-copilot).
- **Antigravity cannot answer Reader Chat**, because this CLI version exposes no
  verified tool-free mode. See [Antigravity](providers/antigravity.md).
- **Native Restricted is available only for Codex**, the one profile that
  currently proves the sandbox contract Interleaf requires.
- **Nothing is published for download yet.** Installers will be releases of the
  public `FrescoFlacko/interleaf-releases` repository, which has none yet. Until then, install a build from
  someone you trust, run from source, or build a package yourself — see
  [Installation](installation.md). Updates for the macOS app and the Linux
  AppImage come only from signed public releases, and only when you click
  Download; see [Installation ▸ Updating](installation.md#updating-and-uninstalling).

---

## Related project documentation

The wiki is written for people using Interleaf. If you are working on the code
instead, the technical documents live one directory up:
[Architecture](../ARCHITECTURE.md), [Security](../SECURITY.md),
[AI Architecture](../AI_ARCHITECTURE.md),
[Agent Runtime](../AGENT_RUNTIME.md),
[Document Formats](../DOCUMENT_FORMATS.md) and [Packaging](../PACKAGING.md).
