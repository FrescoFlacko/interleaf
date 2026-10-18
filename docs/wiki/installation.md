[Wiki home](README.md) › Installation

# Installation

**On this page**

- [What is available today](#what-is-available-today)
- [Requirements](#requirements)
- [Install from a Windows `.exe`](#install-from-a-windows-exe)
- [Run Interleaf from source (macOS, Windows, Linux)](#run-interleaf-from-source-macos-windows-linux)
- [Build a Windows `.exe` installer](#build-a-windows-exe-installer)
- [Build a macOS or Linux package](#build-a-macos-or-linux-package)
- [Optional AI tools](#optional-ai-tools)
- [Where Interleaf keeps your data](#where-interleaf-keeps-your-data)
- [Updating and uninstalling](#updating-and-uninstalling)

---

## What is available today

Read this before you go looking for a download button.

- **Nothing is published for download yet.** Interleaf's installers will be
  published as releases of the public
  [`FrescoFlacko/interleaf-releases`](https://github.com/FrescoFlacko/interleaf-releases)
  repository, which has no release yet. The project website's download buttons
  stay disabled until one is promoted. Packaging and
  publishing are deliberately separate: every package script passes
  `--publish never`, so building a package never uploads it anywhere.
  Maintainers: the release procedure is described in
  [Packaging ▸ Stable updates](../PACKAGING.md#stable-updates).
- **Until then, get a trusted build or run from source.** If someone you trust
  built an installer from this project and gave it to you, installing it is a
  normal, supported thing to do. Otherwise, run Interleaf from source or build a
  package yourself, as described below. Do not install an "Interleaf" download
  from a site you cannot vouch for.
- **Updates come only from signed releases, and only when you ask.** The
  macOS app and the Linux AppImage check Interleaf's public GitHub releases for
  a newer stable version. No release has been published yet, so for now a check
  finds nothing. See [Updating and uninstalling](#updating-and-uninstalling).
- **Signing is a separate step from building.** Release signing on macOS
  (Developer ID plus notarization) and Windows (Authenticode) requires
  certificates this repository does not contain. A build made without them is
  unsigned, so your operating system will warn about the publisher. Treat an
  unsigned build as a structural/smoke build rather than a verified release —
  the project's own packaging notes say the same.

These are the packages the project can build today. None of them is published
yet.

| Platform | Package | Architectures | Signed? |
| --- | --- | --- | --- |
| macOS | `.dmg` and `.zip` | Apple silicon (arm64) and Intel (x64) | Only when built with the project's release command, which signs with a Developer ID and notarizes the DMG. An ordinary package build is unsigned. |
| Windows | NSIS installer (`.exe`) | x64 and arm64 | No, unless a code signing certificate is supplied at build time. |
| Linux | AppImage, `.deb`, and a pacman package (`.pkg.tar.xz`) | The building machine's (x64 in CI) | No. The project's CI builds the AppImage and pacman package for testing only; they are not published. |

There are therefore three routes:

| Route | Good for | Section |
| --- | --- | --- |
| Install a build you were given by someone you trust | A normal desktop app; no terminal or Node.js afterwards | [Windows below](#install-from-a-windows-exe); macOS and Linux packages install the usual way for your system |
| Run from source in a terminal | Everyday use on any platform; fastest to set up | [below](#run-interleaf-from-source-macos-windows-linux) |
| Build a package yourself | Producing an installer for your own machine | [Windows](#build-a-windows-exe-installer), [macOS or Linux](#build-a-macos-or-linux-package) |

---

## Requirements

If you are installing a Windows `.exe`, you need none of the following — skip to
[Install from a Windows `.exe`](#install-from-a-windows-exe). These are the
requirements for running or building from source.

1. **Node.js and npm.** Use a current Node.js release that works with the
   repository's `package-lock.json`. The project does not pin a version for you,
   so if `npm install` fails on an old runtime, upgrade Node and try again.
2. **Git**, to obtain the source (and required later if you want the agent's
   *Isolated Worktree* execution mode).
3. **Disk space** for `node_modules`, plus room for your document library.

Nothing else is required to read documents. AI providers are separate,
optional installs — see [Optional AI tools](#optional-ai-tools).

---

## Install from a Windows `.exe`

Use this if you already have an Interleaf Windows installer from a source you
trust — one you built yourself (see
[Build a Windows `.exe` installer](#build-a-windows-exe-installer)) or one
someone you trust built for you. This route gives you an ordinary Windows
application: no terminal, no Node.js, no `npm` afterwards.

1. **Pick the right build.** The Windows target is built for **x64** and
   **arm64**. Choose the one matching your PC. (Windows ▸ Settings ▸ System ▸
   About shows your system type.)
2. **Run the installer.** Double-click the `.exe`. It is configured as a
   click-through wizard, not a silent one-click install, so you get real steps to
   read.
3. **Expect a publisher warning if the build is unsigned.** Windows SmartScreen
   will say the publisher is unknown. Only continue if you trust where the file
   came from; if you do, choose **More info ▸ Run anyway**.
4. **Choose the installation folder.** The wizard lets you change the
   installation directory, so you can keep it off the system drive if you prefer.
   It installs **for the current user**, so no machine-wide administrator install
   is required.
5. **Finish.** The wizard offers to open Interleaf when it completes.
6. **Open it later from the Start menu.** Search for *Interleaf* and pin it to
   Start or the taskbar. That is all you need from then on — the app launches on
   its own, without a terminal window and without Node.js installed.

Your library lives in the application-data directory described in
[Where Interleaf keeps your data](#where-interleaf-keeps-your-data), not inside
the installation folder.

Next: [Quick start](quick-start.md).

---

## Run Interleaf from source (macOS, Windows, Linux)

This is the same on all three platforms. On Windows, use PowerShell or Windows
Terminal; on macOS use Terminal.

1. **Get the source.** Clone the repository, then move into it:

   ```bash
   git clone <repository-url> interleaf
   cd interleaf
   ```

   *(Use whichever repository URL you were given; the source repository is not
   public.)*

2. **Install dependencies.** From the project folder:

   ```bash
   npm install
   ```

   This takes a few minutes the first time.

3. **Start the app.**

   ```bash
   npm run dev
   ```

   The Interleaf window opens. Leave the terminal running — closing it stops the
   app.

4. **Stop the app** by closing the window, or by pressing `Ctrl + C` in the
   terminal.

To start Interleaf again later, open a terminal in the project folder and run
`npm run dev` again. You do not need to repeat `npm install` unless the
dependencies changed.

### Optional: check your checkout is healthy

If something behaves oddly after updating the source, these commands verify the
code before you spend time debugging the app:

```bash
npm run lint
npm run typecheck
npm test
```

---

## Build a Windows `.exe` installer

This produces the Windows installer file from source on your own machine. **It
does not download one** — nothing is published yet, and every package script
runs with `--publish never`.

> **Build on Windows.** The Windows installer should be produced on a Windows
> machine. Cross-building it from macOS or Linux is not the supported path.

1. Open PowerShell in the project folder.
2. Install dependencies if you have not already:

   ```bash
   npm install
   ```

3. Build and package:

   ```bash
   npm run package:win
   ```

   This runs the application build and then electron-builder. It never publishes
   anything anywhere.

4. When it finishes, look in the **`release/`** folder inside the project. The
   Windows target is an **NSIS** installer, built for **x64** and **arm64**.
5. Run it as described in
   [Install from a Windows `.exe`](#install-from-a-windows-exe).
6. Windows will warn you that the publisher is unknown, because a build made
   without a code signing certificate is unsigned, and this repository provides
   none. `electron-builder.yml` selects SHA-256 signing hashes for when a
   certificate *is* supplied, but that setting does not sign anything by itself.

---

## Build a macOS or Linux package

The same pattern applies to the other platforms. Build each platform on that
platform.

```bash
npm run package:mac     # macOS: .dmg and .zip, arm64 and x64
npm run package:linux   # Linux: AppImage, .deb and pacman (.pkg.tar.xz)
```

Output again lands in **`release/`**.

On macOS, a distributable build also requires an Apple Developer signing
identity and notarization. `npm run package:mac` does not provide them; the
project's separate release command (`node electron.mac-release.ts`) signs,
notarizes and staples a DMG, but only on a Mac that holds the release identity
and notary profile. Without them, macOS Gatekeeper will refuse or warn about the
app, and the result should not be handed out as a trusted macOS release. For a quick unsigned local smoke build, the project's packaging notes
build the compiled application first and then package it:

```bash
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir --mac --arm64 --publish never
```

which leaves an app bundle at `release/mac-arm64/Interleaf.app`. Technical
details live in [docs/PACKAGING.md](../PACKAGING.md).

---

## Optional AI tools

Interleaf detects AI command-line tools that are already installed on your
machine; it never installs them for you. If you want AI Chat or the AI Agent,
install the tool separately and sign in using *its* documented flow, then return
to Interleaf and re-run detection.

The command-line tools Interleaf looks for are:

```text
codex, claude, agy, opencode, pi, omp
```

Detection only reports what is on your machine. Being detected is not the same
as being usable for every feature: some tools are available for AI Chat only,
and others for AI Agent only. GitHub Copilot's CLI is not offered at all,
because this integration cannot run it for unattended Agent Mode. The
[capability matrix](ai-providers.md#the-capability-matrix) is the reference.

Plus two provider types that need no CLI at all:

- **OpenRouter** — paste an API key into Settings.
- **Local server** — point Interleaf at a loopback inference server you are
  already running, such as Ollama.

Two other tools matter only for the agent:

- **git** — required for the *Isolated Worktree* execution mode.
- **Docker or Podman** — *not* required. The Container Sandbox mode is
  unavailable in this implementation and installing a container runtime does not
  enable it.

Setup instructions per provider: [AI providers](ai-providers.md).

---

## Where Interleaf keeps your data

Interleaf stores everything under Electron's application-data directory:

```text
<userData>/
├── database/            SQLite database (library, annotations, chat, sessions)
├── library/             managed copies of your imported documents
├── ai-chat/             AI working data owned by the app
├── agent-workspaces/    isolated agent workspaces and recovery state
├── logs/                bounded, redacted diagnostic logs
└── open-files/          temporary copies of files opened without importing,
                         removed when closed and at every start
```

Typical locations:

| Platform | Typical path |
| --- | --- |
| macOS | `~/Library/Application Support/Interleaf/` |
| Windows | `%APPDATA%\Interleaf\` |
| Linux | `~/.config/Interleaf/` |

These paths are illustrative. The authoritative location is whatever Electron
resolves as `userData` for your installation.

---

## Updating and uninstalling

Interleaf never installs anything on its own. What a newer version takes depends
on how you installed it.

**If you use the macOS app or the Linux AppImage**, open **Settings ▸ About &
Updates**. Interleaf checks for a newer stable release about a minute after it
starts and every 12 hours. Turn off **Check for updates automatically** to stop
that; **Check for updates** still works. A check only looks. Nothing downloads
until you click **Download**, and nothing restarts until you click **Restart to
update**.
Restart waits while an agent run, a chat reply or an import is still running.

Before installing, Interleaf verifies a signed release description against a
key built into the app, and checks every downloaded byte against it. An update
that fails either check is discarded and your current version keeps running.
Updates only ever move forward on the stable channel.

- Checks contact only `github.com` and GitHub's download servers, and send no
  account details, library contents or settings.
- No release has been published yet. Until one is, a check reports that there
  is nothing to compare against. Version 0.5.0 is the first build with the
  release key; an earlier build reports that it cannot verify updates and never
  checks, so install 0.5.0 or later by hand once.
- A macOS copy run from the mounted disk image cannot update itself. Drag it
  to Applications first.
- On Linux the AppImage replaces itself with `Interleaf-<version>.AppImage` in
  the same folder, so keep it somewhere you can write to.

**If you installed a `.deb` or pacman package**, your package manager owns
those files, so Interleaf does not replace them. Settings says so and links to
the release page. Install the newer package the same way you installed the
first.

**Development builds** never check for updates.

**If you installed a Windows `.exe`**, update by running a newer installer for
the same architecture. It replaces the installed application in place; you do not
need to uninstall first.

**If you run from source**, pull the newer source in the project folder,
reinstall dependencies and start again:

```bash
git pull
npm install
npm run dev
```

Either way, your library and annotations live in the application-data directory
above, not in the project folder or the installation folder, so they survive an
update.

**To uninstall:**

- If you ran from source, delete the project folder.
- If you installed a Windows build, uninstall it the normal way from Windows
  Settings.
- To remove your documents, annotations and chat history as well, delete the
  `Interleaf` application-data directory listed above. This is permanent.

---

Next: [Quick start](quick-start.md) · [App navigation](navigation.md) ·
[Help and troubleshooting](help-and-troubleshooting.md)
