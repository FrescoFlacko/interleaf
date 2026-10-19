# Interleaf AI UX Design Principles

How Interleaf's AI surfaces — **Reader Chat** and the **Agent** tab — invite a
first request, help a reader refine it, and show how every result was produced.

The principles below come from three patterns in the
[Shape of AI](https://www.shapeof.ai/) pattern library: **Initial CTA**,
**Follow up**, and **Prompt details**. Each section summarizes the pattern,
says what it means for a local-first, citation-grounded reader, and records the
concrete Interleaf behavior that applies it. Security and architecture rules in
`docs/ARCHITECTURE.md`, `docs/SECURITY.md` and `docs/AI_ARCHITECTURE.md` always win over
anything here: a design principle never justifies a new privilege, a hidden
network call, or rendering untrusted output as markup.

> The patterns are the work of Emily Campbell / ShapeofAI.com. Source pages:
> [Initial CTA](https://www.shapeof.ai/patterns/cta) ·
> [Follow up](https://www.shapeof.ai/patterns/follow-up) ·
> [Prompt details](https://www.shapeof.ai/patterns/prompt-details).

---

## The core principles

These seven principles are what the three patterns have in common. Every AI
surface in Interleaf should be checkable against them.

1. **Never start from a blank box.** Most people do not know how to phrase what
   they want, and a short prompt rarely carries their intent. Surround the input
   with scaffolding: examples, starters, attached context, and visible modes.
2. **Context is part of the prompt, and it sits inside the prompt.** What the
   model will read (pages, selections, notes, the whole document, web search) is
   shown as part of the composer, not as a separate panel. Adding context is a
   first-class action next to typing.
3. **Be forgiving.** Suggestions fill the input rather than firing a request, so
   the reader can edit before anything is spent. Every generated result can be
   copied, reused, or refined; nothing is a dead end.
4. **Refinement is a conversation, not a restart.** After a result, offer a few
   grounded next steps: a zoom-in, a zoom-out, and an action. Ground them in what
   just happened, say why they are offered, keep them few and scannable, and make
   them look different from the answer itself.
5. **Show your work.** Every result can say how it was made: the exact request,
   the provider and model, the context and sources it used, and the parameters
   that shaped it. Show these details on demand, close to the result.
6. **Make results reusable.** Put "Copy prompt" and "Use as template" right next
   to a visible prompt, so a good request becomes a starting point, not something
   to re-type from memory.
7. **Honest over impressive.** Show only facts the app actually knows. When a
   detail was not recorded (for example, which context a past turn used), say so
   or leave it out. Never fabricate provenance.

---

## Pattern 1 — Initial CTA


**What it is.** A prominent set of inputs and actions that starts the
interaction. Usually it is a large input box, surrounded by scaffolding that
helps the user say what they mean with as little effort as possible.

**Scaffolding the pattern calls for**

| Scaffold | Purpose |
|---|---|
| Suggestions | Common prompts near the input remove the blank-page problem. |
| Galleries / examples | Show what is possible before the user commits to a prompt. |
| Prompt enhancers | Help turn a rough request into a well-formed one. |
| Modes and selectors | Let the user choose depth or model without leaving the input. |
| Attachments and connections | Start with richer context and fewer iteration loops. |
| Templates | Pre-built, structured entry points for repeatable jobs. |

**Variations.** *Action-first*: AI sits beside familiar actions. *Contextual*:
AI appears when relevant data exists (a transcript, a file, **an open
document**). *Playful*: entry through surprise and randomness.

**Design principles.** Make the first step forgiving and low-risk. Use compute
efficiently by structuring input up front. Show what is possible before asking
for a custom prompt. Adapt to whether AI is the product or a feature within it.
Balance novelty with clarity.

**In Interleaf (Reader Chat — contextual CTA)**

- The empty thread is an invitation, not an apology. It offers **starter
  prompts** grounded in the open document (the reader already shows the
  document's name, so the empty state does not repeat it): summarize, explain key ideas,
  outline the argument, and — when context is attached — a starter scoped to that
  context. Choosing a starter **fills the composer and focuses it**; it never
  sends.
- The composer is one card, and the prompt field (three lines or more) is its
  main surface. **Attached context sits on a one-line shelf docked directly
  on top of the card**: `Context`, the first attachment's label and `+N` for
  the rest. Pressing it opens the full list in an anchored, keyboard-reachable
  popover, where every item is shown whole and can be removed. An attached
  whole document is shown once, listed first, and removed from that one
  entry. The context-window meter ends the shelf and is drawn nowhere else.
  With nothing attached, the shelf appears only while the meter has something
  truthful to report (*No context attached*, never a fake 0%). Removal is
  withheld while a turn streams or context is being cleaned, and an archived
  conversation shows what it read without offering removal.
- The tool row below the field holds an icon-only **Add context** button
  (whose popover offers *Entire document*, then a PDF page range), **one
  searchable model picker** with its reasoning effort (model name first,
  provider second, grouped by ready provider, in a short scrolling list), web
  search (only when the provider supports it), and a round Send/Stop at the
  right. The row wraps rather than scrolls. Only one of these popovers is open
  at a time, and Escape closes it and returns focus to its trigger.
- The placeholder changes with the conversation: *Ask about this document…*
  before the first turn, *Ask a follow up…* after it.

---

## Pattern 2 — Follow up


**What it is.** Prompts, questions or inline actions that help the user refine
or extend the first exchange, so the model better understands their intent. A
well-timed follow-up saves compute, prevents wasted effort, and shows that the
AI is working *with* the user rather than starting over.

**Types**

- **Conversation extenders** keep a thread going.
- **Clarifying questions** confirm intent before expensive work.
- **Depth probes** zoom in on a detail.
- **Comparisons** offer alternatives, pros and cons, or benchmarks.
- **Action nudges** turn a result into a next step (save, send, apply).
- **Share / export** carries the result somewhere else.

**Design considerations**

1. Ground suggestions in the preceding response; avoid generic prompts.
2. Explain why a suggestion is offered, using transitional phrasing.
3. Keep options few (about three) and easy to scan.
4. Mix a **zoom-in** refinement with a **zoom-out** pivot.
5. Make follow-ups look different from the main output.
6. Let the user refresh the set of suggestions.

**In Interleaf**

- **Reader Chat.** Under the latest completed answer, a small, clearly labelled
  *Suggested follow-ups* row offers at most three chips: one zoom-in (depth
  probe), one zoom-out (a comparison or wider pivot), and one action nudge. They
  are derived deterministically in the renderer from the answer and its
  citations, the attached context, and the document — **no extra model call**.
  A chip fills the composer; the reader edits or sends. A refresh control rotates
  to a different grounded set. Follow-ups never appear while an answer streams,
  or on a failed or stopped answer, which gets a *Retry* nudge instead.
- **Agent.** After a run ends, the resume composer offers follow-up chips
  grounded in the session's outcome: review the changes when files changed,
  explain the result, add or run tests, or retry after a failure. Chips fill
  the resume field and never start a run by themselves.

---

## Pattern 3 — Prompt details


**What it is.** Showing the prompt and its parameters next to a generated
result, so people can see how it was produced, learn phrasing, judge
originality, and reuse or remix it.

**What to include.** The prompt text; negative prompts; model name and version;
seed and profile; parameters; referenced attachments with their purpose; tags
or style tokens.

**Where it can live.** Inline under the artifact, in a side panel on selection,
or in an expandable *Details* section.

**Design considerations**

1. Prioritize copyability: copy the prompt, or send it to the input box.
2. Surface reference inputs (attachments, seeds, profiles) so users can remix.
3. Default to visibility where the goal is learning.
4. Let the creator hide or redact details.
5. Label parameters separately from the prompt text.
6. Put *Copy prompt* and *Use as template* next to the visible prompt.
7. Use one consistent presentation across media types.

**In Interleaf**

- **Reader Chat.** Every completed answer has a collapsed **Prompt details**
  disclosure. It shows the exact request that produced the answer and, as
  labelled parameter tokens, facts the app actually holds: provider, model,
  number of cited sources, and web sources when search was used. It offers
  *Copy prompt* and *Reuse prompt* (fills the composer). It does not claim which
  context items a past turn used, because turns do not record that (principle
  7).
- **Agent.** The run's *Task* block becomes **Run details**: the full task prompt
  with *Copy prompt* and *Use as new task*, plus the attached context. Profile,
  model, working directory and execution mode are already stated once in the
  run header directly above, so Run details does not repeat them.

---

## Agent output — result first

The same principles govern how a finished agent run reports back:

- **Lead with the outcome.** A single **Result** card sits at the top of the
  output: status, the final report rendered as safe, sanitized Markdown (never
  raw HTML), a short outcome line (for example *1 changed file · tests 0 passed,
  0 failed*), and *Copy result*. The final report is not shown twice.
- **The timeline is evidence, not the answer.** The activity feed stays
  available and filterable below the result, for readers who want to audit what
  happened.
- **Review before apply.** Workspace review, risk and diff keep their current
  safety posture and stay close to the result they explain.
- **Continue, don't restart.** Grounded follow-up chips feed the resume composer
  (Pattern 2).

---

## Guardrails that always apply

- Starters, follow-ups and details are **renderer-derived text** from data the
  renderer already has. They add no IPC channel, no network call, and no model
  call.
- Model, document and agent output stay **untrusted**. They render as text or
  through the existing sanitized Markdown path, never as raw HTML.
- Nothing auto-sends. Every suggestion is a draft the reader controls.
- Every new control has an accessible name, works with the keyboard, keeps a
  visible focus ring, and fits the 280 px minimum companion width and 200% zoom
  without horizontal overflow.
- Visual language follows the existing chat/agent design tokens (`chat-design.css`,
  `agent-design.css`): follow-ups use a quieter accent treatment than answers;
  parameter tokens use the mono label style already used for run metadata.
- **State each fact once.** A detail already visible on screen (the document
  name in the reader, run parameters in the run header) is not repeated in a
  second place.
