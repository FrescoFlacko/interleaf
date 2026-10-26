[Wiki home](README.md) › AI Agent

# AI Agent

AI Agent runs a coding agent — Codex, Claude Code, Antigravity, OpenCode or Pi —
against a folder on your machine, with the passage you are reading attached as
reference.

(GitHub Copilot is not offered: this integration cannot run it unattended; see
[Before you start](#before-you-start).)

It is the other half of Interleaf's AI, and it is genuinely different from
[AI Chat](ai-chat.md): chat answers questions, the agent runs commands and
writes files.

Because of that, the **default** execution mode works in an isolated workspace
Interleaf prepares — a temporary Git worktree for a repository, a directory copy
otherwise — so that changes reach your project only when you review a diff and
choose **Apply**. That is a property of the *default* mode, not of every run:
the two **Direct workspace** modes (Native Restricted and Active Environment)
write to the folder you selected as the run happens, and have no Apply step at
all. And isolation of any kind bounds where the agent is *pointed*, not what a
third-party CLI is capable of touching — read
[What "isolated" does and does not mean](#what-isolated-does-and-does-not-mean)
before your first run.

---

## On this page

- [Before you start](#before-you-start)
- [Opening the panel](#opening-the-panel)
- [1. Describe the task](#1-describe-the-task)
- [2. Attach document context](#2-attach-document-context)
- [3. Choose the working directory](#3-choose-the-working-directory)
- [Execution environments](#execution-environments)
- [4. Choose the agent and model](#4-choose-the-agent-and-model)
- [5. Start the run](#5-start-the-run)
- [Watching the run](#watching-the-run)
- [Stopping a run](#stopping-a-run)
- [Reviewing what changed](#reviewing-what-changed)
- [Applying, exporting or discarding](#applying-exporting-or-discarding)
- [The final report](#the-final-report)
- [Resuming a session](#resuming-a-session)
- [Managing working directories](#managing-working-directories)
- [When Start agent is blocked](#when-start-agent-is-blocked)

---

## Before you start

You need three things:

1. **An installed agent CLI that this integration can run unattended.** Interleaf
   does not install one for you. See [AI providers](ai-providers.md) and pick a
   provider whose **AI Agent** column is ✅.

   **GitHub Copilot is not one of them.** Interleaf's current integration cannot
   run it for unattended Agent Mode, so it is not listed as an agent at all.
   That is a decision in this integration, not a detection result: installing
   the Copilot CLI will not add it, and there is no setting to turn it on.
2. **A library document open.** The agent panel is part of the reader. A file
   you opened without importing it cannot be used: Agent Mode refuses it with
   *Agent Mode works with documents in your library.* Import it first — see
   [Open a file without importing it](adding-documents.md#open-a-file-without-importing-it).
3. **A folder to work in.** You choose it explicitly, every time or as a saved
   default.

---

## Opening the panel

1. Show the right companion panel — `⌘ Shift + A` on macOS,
   `Ctrl + Shift + A` on Windows and Linux.
2. Select the **Agent** tab.

With no run in progress the panel is the new-task view, headed **New agent
task** — *Runs a coding agent against a folder on this machine*. It has three
parts, top to bottom:

- The **Task** card: what the agent should do, and any attached context.
- The **Run settings** card: working directory, execution environment, agent
  and model.
- A bar pinned to the bottom with **Start agent** and a status line.

The **All sessions** chip in the header opens the list of earlier runs for this
document.

![The Agent tab beside a PDF page: a drafted task with an attached passage marked as an untrusted reference, and Run settings with no folder selected](../../website/assets/screens/reader-agent-1600.webp)
*A drafted task, not started. The agent shown is an inert test fixture; nothing
was run.*

---

## 1. Describe the task

Type into the **Task** field. Its placeholder is *Describe what the agent should
do…* (or *Open a document to enable the agent composer…* when no document is
open).

Press <kbd>↑</kbd> in an empty field to recall previous prompts for this
document.

Be specific. "Add a test for the retry path in `fetchWithBackoff` and run the
suite" gives a much better run than "fix the tests".

---

## 2. Attach document context

Nothing from your document is sent unless you attach it. When nothing is
attached the footer says so plainly:

> No document attached. Nothing from it is sent unless you add it.

Three controls sit in the task card's footer:

| Control | When it appears | What it attaches |
| --- | --- | --- |
| **+ Selection** | Only while text is selected in the reader | That passage |
| **+ Pages…** | PDF only | A page range you enter |
| **Entire document** | Always | The whole document |

Once attached, a summary replaces the controls: the document title, the range,
the first part of the quote, and a line stating exactly what was captured — for
example *Attached as untrusted reference (1,204 chars)*, or *Attached as
untrusted reference (first 98,210 chars, truncated)* when the passage was larger
than a context packet may carry.

**Untrusted reference** is the important phrase. The passage is given to the
agent as material to read, never as instructions to obey. Select **Remove** to
detach it.

---

## 3. Choose the working directory

In the **Run settings** card:

1. Select **Choose…**
2. Pick a folder in the system dialog.

Until you do, the field reads **No folder selected**. Choosing the folder in that
dialog is how you tell Interleaf which folder to prepare — or, in a direct
workspace mode, to run in. The caption beneath the field records where the
current selection came from (a fresh choice, a saved directory, or a profile
default); a saved default only pre-fills that choice.

This choice decides where Interleaf points the run. It does not put a limit on
what the agent CLI itself can reach — see
[What "isolated" does and does not mean](#what-isolated-does-and-does-not-mean).

To save folders you use repeatedly, select **Manage directories** — see
[Managing working directories](#managing-working-directories).

---

## Execution environments

The **Execution environment** menu decides where the run happens — whether the
agent works in a workspace Interleaf prepares for it, or directly in the folder
you selected — and therefore whether there is a diff to review afterwards. It is
not a limit on the CLI's own filesystem authority; see
[What "isolated" does and does not mean](#what-isolated-does-and-does-not-mean).
A badge beside the menu tells you which kind of run you have selected:
**Sandboxed** (green) or **Direct workspace** (amber).

| Mode | Badge | What it does |
| --- | --- | --- |
| **Auto-Isolated (Recommended)** | Sandboxed | *Git repositories resolve to Isolated Worktree; non-Git directories resolve to Isolated Directory Copy.* This is the default. |
| **Isolated Worktree** | Sandboxed | Runs in a temporary git worktree under Interleaf-managed storage. Your repository stays clean until you review and apply the diff. |
| **Isolated Directory Copy** | Sandboxed | For non-Git directories: copies the project to a managed sandbox, runs there, and computes a delta for review. |
| **Native Restricted** | Direct workspace | Asks the agent CLI to use its own restricted permission mode (for example Codex workspace-write) against the directory you selected. Writes land in that directory as the run happens; there is no diff to apply afterwards. Available only for a CLI that has proved a supported native sandbox — currently Codex. |
| **Active Environment** | Direct workspace | Runs the agent directly in the selected working directory with write access. **Nothing is isolated**, and again there is no Apply step. |

Two rules are worth internalising:

- **The two Direct workspace modes are confirmed in a native system dialog before
  they can run**, every time — a saved setting cannot pre-approve them, and
  neither a document nor a model can trigger one on your behalf.
- **Active Environment can never become a saved default.** Nor can Native
  Restricted. They are deliberate, single-run choices; **Settings ▸ Agent
  Sandboxing** only offers the isolated ones.

### What "isolated" does and does not mean

Worth being precise, because the word is doing a lot of work.

An isolated worktree or copy is **workspace** isolation: it changes *where the
agent is started and where it is meant to work*, so that ordinary work does not
touch your active project until you apply it. It is **not** an
operating-system or container boundary. The agent CLI is a third-party program
running under your own user account, so it can read **and write** anywhere your
account can — outside the worktree, outside the project, elsewhere on your
computer — particularly if it was configured with a permission-bypass or
"dangerous" flag of its own. Interleaf cannot revoke that.

So treat the execution environment as a choice about where work is *directed*,
not as a guarantee about everything a run is *able* to do. Run agent CLIs you
trust, on projects you are willing to have touched. Interleaf's in-app privacy
policy (**Settings ▸ Privacy**) and
[docs/SECURITY.md](../SECURITY.md) say the same thing.

### Container Sandbox is not available

You may see **Container Sandbox** referenced in Interleaf's architecture
documents. It is **not offered in the menu**, because no verified rootless
bounded executor exists (ADR-0008). If an old setting still names it, Interleaf
falls back to **Auto-Isolated** for display and refuses to run it. This is
fail-closed on purpose: a mode that claims container isolation it cannot deliver
would be worse than no mode at all.

When a mode that *is* in the menu cannot run, the entry says so inline. Native
Restricted is the one you are most likely to meet: for any CLI that has not
proved a supported native sandbox, it appears as *Unavailable: the selected
main-owned adapter has not proved a supported native sandbox and safe
noninteractive arguments.*

---

## 4. Choose the agent and model

- **Agent** lists each profile with its detection state, as
  `Codex — Installed` or `OpenCode — Not installed`. GitHub Copilot is not
  listed. Below the menu a caption
  reads **Installed · sandbox capable** or **Installed · isolated sandbox
  default**, so you know whether the CLI brings its own sandbox or relies on
  Interleaf's.
- **Model** offers **Provider default** plus whatever that CLI published. The
  caption is honest about the edge cases: *This CLI reported no models. Add the
  ones it accepts under Settings → Agent Profiles.*

The model applies to the next run — *Resuming a session keeps the model it
started with.*

Your choices here are the same preferences the Settings editor owns, so they
persist.

---

## 5. Start the run

Select **Start agent**. The status line beside it always says either *Ready to
start.* or the single reason it cannot — see
[When Start agent is blocked](#when-start-agent-is-blocked).

---

## Watching the run

The run view replaces the composer. Its header shows:

- **New task** (back to the composer — the run keeps going)
- The heading **Agent session** and a status pill: **Queued**, **Running**,
  **Waiting**, **Completed**, **Failed**, **Cancelled** or **Interrupted**
- **Stop**, while there is something to stop
- A **⋯** control (**All sessions**) for switching to another run
- A metadata line: profile / model / working directory / execution mode, and
  elapsed runtime

Under the header, **Run details** repeats the full task prompt and its attached
context, with **Copy prompt** and **Use as new task**. *Use as new task* only
puts the prompt in the new-task field; you review it and start the run
yourself.

When the run ends, a **Result** card leads the view: the final status, the
agent's closing report, and a one-line outcome (changed files and reported
tests). See [The final report](#the-final-report).

Below it, **Activity** streams what the agent is doing, with an event count and
a **Filter activity by type** menu: **All**, **Agent messages**, **Commands**,
**Files**, **Tests**, **Errors**, **Status & other**.

How much detail you get depends on the CLI. Codex, Claude Code, Antigravity and
OpenCode stream structured output, tool activity and file changes; Pi reports
tool activity but not file-change events. That is a property of each tool, not a
setting — see [AI providers](ai-providers.md).

---

## Stopping a run

Select **Stop**. The button becomes **Stopping…** while the request is in
flight, and the session ends as **Cancelled**.

Stopping does not roll anything back. Whatever the agent wrote into its sandbox
before you stopped is still there, and still reviewable — which is usually what
you want.

---

## Reviewing what changed

When the run finishes with an environment to review, the review card appears at
the bottom of the activity list:

- The workspace label and a risk badge (**low risk** / higher)
- *Working directory: … · Execution mode: …*
- The count of changed files
- **Active workspace modified directly.** — shown in red, only after a Direct
  workspace run, because in that case there is nothing to apply: it already
  happened
- The reason applying is unavailable, when it is

Expand **Review** to see:

- **Changed files** — each path with its kind and `+additions / −deletions`.
  Long lists are capped, and say so: *Showing the first 100 of 340 changed
  files.*
- **View Diff** — the unified diff, when one is available. Very large diffs are
  truncated for display.

Expand **Test outcomes** for any tests the agent reported, each with its status,
summary, exit code and duration. *No test results reported.* means the agent did
not report any — not that tests passed.

---

## Applying, exporting or discarding

The actions inside **Review**:

| Action | What it does |
| --- | --- |
| **Apply Changes** | Applies the sandbox's changes to your real working directory. Shown only when applying is allowed. |
| **Export Patch…** | Saves the diff as a patch file instead of applying it. |
| **Open Folder** | Opens the sandbox in your file manager, so you can inspect it yourself. |
| **Discard Sandbox** | Throws the sandbox away. |
| **Refresh** | Re-reads the sandbox, in case something changed underneath. |

Only one of these runs at a time; the row disables itself while an action is in
flight.

**Read the diff before applying.** The whole isolation design exists to make
that step possible; it is not a formality.

---

## The final report

Agents that write a closing summary have it shown in the **Result** card at the
top of the run, with **Copy Result** to copy it. Copying confirms with the
character count, so you know the whole thing landed. The report is agent output:
it is displayed as sanitized text, with links and images kept inert. In the
activity list the report appears only as a one-line marker, so it is not shown
twice.

### Diagrams in agent output

A fenced `mermaid` block in the final report, or in an **Agent messages** entry
in the activity list, is drawn as a picture. Drawing happens on your machine with
the bundled Pele renderer, offline. The caption names the diagram type, **Show
source** reveals the original text with **Copy code**, and a wide diagram scrolls
sideways within its frame. A diagram that can't be drawn shows its source with a
one-line reason, and at most six are drawn per report or message. **Copy
Result** copies the original Markdown.

---

## Resuming a session

Some runs can be continued in the same workspace with a follow-up instruction.
The composer at the bottom of a finished run reads *Follow-up instructions to
resume in the same workspace…*, with **Same workspace · &lt;mode&gt;** beside
the **Resume** button.

**This is Codex only.** No other built-in profile declares session resume, so
for every other agent the composer simply is not there. See the
[capability matrix](ai-providers.md#the-capability-matrix).

Resume also disappears once the environment is settled, and says why:

> Resume is unavailable because this environment was already applied. Start a
> new session to continue.

> Resume is unavailable because this environment was discarded. Start a new
> session to continue.

On success the status line reads *Session resumed.*; on failure, *Could not
resume session.* or *Resume failed: &lt;reason&gt;*.

Above the field, **Suggested follow-ups** offers chips such as **Retry** (after
a run that did not complete), **Review the changes** (when files changed),
**Explain the result** and **Add or run tests**. A chip *Fills the follow-up
field; nothing is started.* You still select **Resume** yourself.

Follow-up prompts are remembered for this run and this window only — press
<kbd>↑</kbd> to recall them. They are not stored.

---

## Managing working directories

**Settings ▸ Agent Working Directories** (or **Manage directories** in the
panel) holds three things:

1. **Default Agent Workspace** — *Automatically selected in the Agent Task
   Composer when starting new tasks.*
2. **Global Working Directories** — folders you saved, added with **Add
   directory…** and removed with **Remove**. There is a cap on how many you can
   save; the button disables when you reach it.
3. **Default Working Directory by Profile** — one default per agent profile.
   *Choose None to select a capability for each run. Defaults are settings only
   and do not grant or revoke filesystem access.*

That last sentence is the one to remember: a saved default is a convenience that
pre-fills the folder field for a run you still start yourself. Saving a folder
in Settings is not a grant, and removing one is not a revocation.

A folder that has gone away is listed as **Unavailable saved directory** so you
can clear it.

---

## When Start agent is blocked

The status bar names the first unmet precondition, in this order:

| Message | What to do |
| --- | --- |
| *Open a document to start an agent task.* | Open a document. |
| *Select an installed agent profile to start.* | No profile is selected. |
| *&lt;Profile&gt; is not installed on this machine.* | Install that CLI. See [AI providers](ai-providers.md). |
| *Unavailable: …* (an execution-mode reason) | Choose a different execution environment. |
| *Choose a working directory to start.* | Select **Choose…** |
| *Describe the task to start.* | The **Task** field is empty. |
| *Starting…* | It is already starting. |

More in [Help and troubleshooting](help-and-troubleshooting.md#ai-providers).

---

Related: [AI providers](ai-providers.md) · [AI Chat](ai-chat.md) ·
[Navigation](navigation.md) · [FAQ](faq.md)
