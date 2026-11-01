# Website claims → evidence

Each claim on `website/index.html` comes from the application source and the
user wiki in `docs/wiki/`. Where the two disagree, the site follows the source.
Paths are relative to the repository root. `tests/unit/website/website-site.spec.ts`
checks that every path listed here exists.

| Site section | Claim | Evidence |
| --- | --- | --- |
| Formats strip | PDF, EPUB, MOBI/AZW/AZW3, DOCX, PPTX, Markdown and saved web articles | `docs/wiki/formats/README.md`, `src/main/library/file-signatures.ts` |
| Formats strip, limits | DRM-protected EPUB and Kindle books are refused | `src/renderer/features/reader/adapters/foliate/epub.ts`, `src/renderer/features/reader/adapters/foliate/mobi.ts`, `docs/wiki/formats/mobi-kindle.md` |
| 01 Library | Import, drag and drop, managed copy or link in place with missing/changed flags | `src/renderer/features/library/components/ImportDropzone.tsx`, `src/main/library/storage-manager.ts`, `docs/wiki/adding-documents.md` |
| 01 Library | Save a public web article as a Markdown snapshot, with still images archived | `src/main/library/web-article-import.ts`, `src/main/library/article-media.ts`, `docs/wiki/adding-documents.md` |
| 01 Library | Saved views, nested folders, filter, sort, grid and list | `src/renderer/components/LibrarySidebar.tsx`, `src/renderer/features/library/LibraryView.tsx`, `docs/wiki/navigation.md` |
| 01 Library | Duplicates recognised by SHA-256 of the content | `src/main/workers/hash-file-worker.ts`, `src/main/library/library-service.ts`, `docs/wiki/adding-documents.md` |
| 01 Library | Guided first-run setup; no account or AI needed to read | `src/shared/constants/onboarding.ts`, `docs/wiki/quick-start.md` |
| 02 Reading | Six palettes | `src/shared/constants/palettes.ts`, `src/renderer/components/AppHeader.tsx` |
| 02 Reading | Line spacing, margins, font size and family (OpenDyslexic-compatible), zoom presets, remembered position | `src/renderer/features/reader/adapters/ebook-base-adapter.ts`, `docs/wiki/reading.md` |
| 02 Reading | Focus Reading Mode, F11 / Esc | `src/renderer/stores/use-reader-store.ts`, `src/shared/constants/shortcuts.ts` |
| 03 Highlights | Five named colours; notes on text or location; bookmarks | `src/shared/constants/annotations.ts`, `docs/wiki/highlights-and-notes.md` |
| 03 Highlights | Annotations browser: search, filter, sort, jump | `docs/wiki/highlights-and-notes.md` |
| 03 Highlights | Reflowable highlights anchored several ways | `docs/wiki/highlights-and-notes.md` |
| 04 Search | Full-text search of the **open document** only | `src/renderer/features/search/SearchPanel.tsx` ("Search covers the open document only"). The wiki's "Library" scope is stale; see the handoff report. |
| 04 Search | No OCR for image-only PDFs | `docs/wiki/formats/pdf.md`, `docs/wiki/reading.md` |
| 05 Chat | Attach a selection, a PDF page range, the whole document or a note | `src/main/ai/context-builder.ts`, `src/main/ai/pinned-whole-document.ts`, `docs/wiki/ai-chat.md` |
| 05 Chat | Citation chips only for attached sources | `src/renderer/features/chat/MarkdownMessage.tsx`, `docs/wiki/ai-chat.md` |
| 05 Chat | Context meter and Clean Context | `src/renderer/features/chat/ChatComposer.tsx`, `src/main/ai/compaction-runner.ts` |
| 05 Chat | History; save an answer as a note | `src/renderer/features/chat/ChatHistoryView.tsx`, `src/renderer/features/chat/ChatMessageBubble.tsx` |
| 05 Chat | Web search only with OpenRouter | `src/main/ai/providers/openrouter-provider.ts`, `docs/wiki/ai-chat.md` |
| 05 Chat | Unsafe links rendered inert | `src/renderer/components/markdown/MarkdownContent.tsx` |
| 06 Agent | Selection, page range or whole document plus a task and a working folder | `docs/wiki/ai-agent.md` |
| 06 Agent | Auto-Isolated default (worktree or directory copy); review, apply, export patch, discard | `src/shared/constants/agent-modes.ts`, `src/renderer/features/agent/AgentReviewCard.tsx` |
| 06 Agent | Direct-workspace modes confirmed natively | `src/main/index.ts`, `docs/wiki/ai-agent.md` |
| 06 Agent | Isolation is not an OS sandbox | `docs/wiki/faq.md` ("Are isolated execution modes a real sandbox?") |
| Local-first | Data stays local; no account or sync; OpenRouter key in `safeStorage` | `src/renderer/features/settings/PrivacyPolicy.tsx`, `src/main/ai/credential-storage-backend.ts`, `docs/wiki/faq.md` |
| Local-first | Logs bounded and redacted | `src/main/agents/event-redaction.ts`, `docs/wiki/faq.md` |
| Local-first | macOS app and Linux AppImage check public GitHub releases for a signed update; download only on click; checks can be turned off | `src/main/updates/update-service.ts`, `src/main/updates/update-trust.ts`, `docs/wiki/installation.md` ("Updating and uninstalling") |
| Local-first | Network traffic outside inference: detection and sign-in, local model listing, web articles, the CLIs themselves | `docs/wiki/faq.md`, `docs/wiki/ai-providers.md`, `src/main/net/web-article-transport.ts` |
| Providers | The Chat and Agent columns | `docs/wiki/ai-providers.md`, `src/main/ai/provider-registry.ts`, `src/shared/constants/agent-modes.ts` |
| Limits | No editing, no interactive media, no DRM removal | `docs/wiki/reading.md` ("What readers do not do"), `docs/SECURITY.md` |
| Download | macOS dmg for arm64 and x64, version 0.3 | `electron-builder.yml`, `package.json` |
| Download | Nothing is published yet; installers will live on a separate download host that is still pending | `website/site.config.json` (every URL `null`), `docs/PACKAGING.md` ("Stable updates") |
| Download | Linux packages: .deb (Ubuntu, Debian), pacman (Omarchy, Arch Linux), AppImage (other distributions) | `electron-builder.yml`, `.github/workflows/linux-package.yml`, `README.md` ("Linux and Omarchy install") |
| Download | Runs under Wayland or X11 on Linux | `src/main/app/linux-platform.ts` |
| Tagline | "Read. Think. Build." | `src/shared/constants/brand.ts` |

## Deliberately not claimed

- Library-wide full-text search. The current UI searches the open document only.
- Any published download, auto-update, signing or notarisation status for a
  public build.
- Windows or Linux downloads, or testing on specific distribution versions.
- Container or operating-system sandboxing.
- Live AI quality. The only answer shown is a labelled fixture.
