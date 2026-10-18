# Interleaf — User Experience & Interface Specification

> **Read. Think. Build.**  
> Visual Hierarchy, 24 Themes, Focus Mode, Context Chips, Keyboard Navigation and Motion.

---

## 1. Visual Hierarchy & 3-Column Layout

Interleaf prioritizes the reading experience above all else. The document viewport is the visual center of gravity, occupying $> 60\%$ of screen width by default:

```
┌──────────────┬──────────────────────────────────────────────┬──────────────────────┐
│ Library Nav  │              Document Viewport               │ AI Chat & Annotations│
│ (Collapsible)│                                              │ (Collapsible)        │
│              │  ┌────────────────────────────────────────┐  │                      │
│ • All Books  │  │                                        │  │ 📘 DDIA.pdf          │
│ • Folders    │  │       "Leader-based replication        │  │ 📄 Context: p. 42-45 │
│ • Recent     │  │        requires all writes to..."      │  │                      │
│              │  │                                        │  │ 💬 AI Conversation   │
│              │  └────────────────────────────────────────┘  │ 🖍 Highlights (14)   │
│              │   Page 42 of 560 ═══════════ (8%)            │ 🔖 Bookmarks (3)     │
└──────────────┴──────────────────────────────────────────────┴──────────────────────┘
```

---

## 2. Themes (24 Palettes)

Interleaf ships 24 palettes, 13 light and 11 dark, each with a light or dark
`appearance`. The six original ids (`paper`, `sepia`, `moss`, `ocean`,
`graphite`, `midnight`) are kept, so existing settings stay valid; their values
were retuned to meet the contrast targets below, which most visibly darkens
Paper's secondary text.

| Light | Mood | Dark | Mood |
|:---|:---|:---|:---|
| Paper (default) | Neutral daylight page, sky-ink links | Graphite | Medium slate for long evenings |
| Sepia | Traditional low-glare ebook page | Midnight | True-black OLED reading |
| Moss | Muted lichen green, quiet focus | Ink | Blue-black ink, lamplight amber |
| Ocean | Crisp blue-grey coast light | Nocturne | Deep violet night, mint highlights |
| Porcelain | Cool white with cobalt glaze | Evergreen | Pine forest at dusk, brass accents |
| Birch | Pale bark grey, charcoal ink | Abyss | Deep-sea teal, soft cyan |
| Celadon | Glazed jade with deep teal | Carbon | Neutral graphite fibre, signal blue |
| Fjord | Glacial grey-blue, slate water | Oxblood | Leather-bound library, rose-gold |
| Heather | Lavender moor, aubergine ink | Dusk | Indigo twilight, apricot glow |
| Marigold | Butter-yellow page, indigo ink | Umber | Roasted earth, parchment text |
| Rosewater | Blush page, oxblood ink | High Contrast Dark | Maximum legibility, white on black |
| Chalk | Editor's white with red-pencil marks | | |
| High Contrast Light | Maximum legibility, black on white | | |

The ids, labels and moods live in `src/shared/constants/palettes.ts`; the token
values live in `src/shared/constants/palette-tokens-light.ts` and
`palette-tokens-dark.ts`. Those tables are the single source of truth, and
this document does not repeat their hex values.

### Tokens

Every palette defines the same colour tokens: `bg-primary`, `bg-surface`,
`bg-surface-elevated`, `bg-reader`, `text-primary`, `text-secondary`,
`border-subtle`, `border-strong`, `accent`, `accent-muted`, `selection`,
`focus-ring`, `danger`, `success`, `warning`, `on-accent` and `search-mark`.
It also defines the alphas of the translucent selection and note paints.
`tokens.css` declares Paper's values as the defaults, and
`tests/unit/palette-tokens-css.spec.ts` keeps them equal to the table.

Applying a palette (`applyPalette`) sets every token on the root element,
together with `data-theme`, `data-appearance` and `color-scheme`, so native
scrollbars and form controls follow the palette. Theming is renderer-only and
adds no IPC; the choice persists through the existing `appearance.palette`
setting.

### Where a palette applies

- **Whole app.** One choice repaints the shell, library, reader, pdf.js
  layers, the EPUB/MOBI frame, Markdown and search marks, Reader Chat, Agent,
  Settings, onboarding, menus and popovers. Text colours are solid tokens;
  no text colour is made by lowering opacity.
- **Reader page.** The reader background is either "Match theme" or another
  palette. Another palette brings its complete set of roles to the document
  region (text, headings, links, quotes, code and in-page controls), so each
  role is paired with the page it sits on; the reader toolbar and outline stay
  on the app palette. The paginator decides whether a frame is dark from the
  palette's `appearance`, never from the shape of a colour value.
- **Exceptions.** A document's own images and media are not recoloured, and
  Mermaid diagrams use the pinned sets below.
- **Mermaid diagrams.** Diagrams render in their own sandbox, which is told
  only whether to draw light or dark and is never given a colour. They use two
  fixed, readable colour sets rather than the palette's tokens.

### Choosing a theme

- **Settings → Theme.** All 24 palettes, under Light and Dark headings with
  their counts. The cards are one radio group: arrow keys move the selection
  across both headings, wrapping at the ends. Each card shows a small preview
  drawn from that palette's own tokens, a concise name ("High Contrast" under
  its heading; the radio's accessible name stays "High Contrast Dark") and its
  mood as the description. The chosen card carries a check and is scrolled into
  view when the section opens. The reader page background list shows each
  palette's swatch.
- **Header menu.** A short menu shows the current theme, up to six recently
  used ones, and "All themes…", which opens Settings → Theme.
- **Theme changes.** A change cross-fades over 200ms through a view transition,
  and applies at once under reduced motion.
- **Unknown palettes.** If the stored settings name a palette this build does
  not know, for example one written by a newer build, only that field falls
  back: to Paper, to "Match theme", or out of the recent list. All other
  settings are kept.

### Contrast targets

`tests/unit/palette-contrast.spec.ts` checks every palette against these
token-level targets. A failing pair blocks release.

| Pair | Minimum |
|:---|:---|
| Body and secondary text on `bg-primary`, surfaces and `bg-reader` | 7:1 |
| `accent` on `bg-primary` and `bg-reader` | 7:1 |
| `accent` on surfaces | 4.5:1 |
| `danger`, `success` and `warning` on `bg-primary` | 7:1 |
| `danger`, `success` and `warning` elsewhere | 4.5:1 |
| `on-accent` on `accent` | 7:1 |
| `text-primary` on `accent-muted` and `selection` | 7:1 |
| `text-primary` on the selection and note paints composited over `bg-reader` | 7:1 |
| `text-primary` on `search-mark` | 7:1 |
| `focus-ring` and `border-strong` | 3:1 |

The test also checks that the palettes are distinct from one another.

These checks are token-level, and an automated axe scan is used as a
complementary check. Neither certifies conformance with any accessibility
standard. Highlight colours and agent risk levels also carry icons, labels or
patterns, so colour is never the only cue.

---

## 3. Distraction-Free Focus Reading Mode

- **Activation**: Toggled via `F11`, application menu, or toolbar button.
- **Behavior**:
  * Collapses Library sidebar, AI drawer, and main application header.
  * Hides all floating toolbars and buttons.
  * Displays only the document text and a subtle, 2px progress bar along the bottom edge.
  * Moving the mouse near the top edge reveals a temporary minimal header for quick navigation.
- **Exit**: Pressing `Esc` or `F11` instantly restores the previous multi-panel workspace.

Focus entry takes an in-memory snapshot of both panel open states and widths, the active Companion tab, the reader outline state, and the invoking focus target. The snapshot is cleared on exit and is never written to settings. A 2px progress indicator remains at the bottom edge; moving to the top edge exposes only a temporary title/progress affordance and Exit button. All focus transitions honor `prefers-reduced-motion`.

### Resizable panels

Library and Companion panels have independent toggle buttons and bounded separators (`role="separator"`, vertical orientation, pixel value labels). Pointer dragging and `ArrowLeft`/`ArrowRight`/`Home`/`End` keyboard controls share the same clamp, preserving a minimum reading center and restoring safely when the window is smaller. Persisted widths are validated by the settings schema; collapse state and Focus Mode are transient UI state.

---

## 4. Contextual Selection Toolbar & Highlight Actions

Selecting any passage of text immediately reveals a floating contextual popover:

```
┌────────────────────────────────────────────────────────────────────────┐
│ [🟡 Highlight ▾] [💬 Add Note] [✨ Add to AI Context] [Ask AI] [🤖 Agent] [📋 Copy]│
└────────────────────────────────────────────────────────────────────────┘
```

- **Highlight ▾**: Applies active highlight color (dropdown selects: Yellow, Blue, Green, Pink, Purple).
- **Add Note**: Opens an inline Markdown note editor anchored directly beside the selection.
- **Add to AI Context**: Adds the exact selection as a removable, provenance-bearing context chip without sending a message; the right drawer announces the new chip through an `aria-live="polite"` status region.
- **Ask AI**: Opens the right AI drawer, attaches the exact passage as an explicit context chip, and focuses the message input with placeholder: *"Ask something about this passage..."*.
- **Submit to Agent**: Opens the Agent Task composer with the excerpt pre-populated in the context packet.
- **Copy**: Writes plain selected text to the clipboard through a user-gesture-bound domain command and announces success/failure; it never copies hidden markup or document instructions.

The toolbar uses a roving-tabindex pattern: `Tab` enters/leaves, arrow keys move between actions, `Enter`/`Space` activates, and `Esc` dismisses while returning focus to the selection anchor. Each icon has the accessible name shown above and a visible tooltip; the color menu is keyboard navigable and names every color.

---

## 5. AI Chat Context Chips & Provenance Navigation

```
┌────────────────────────────────────────────────────────┐
│  AI Conversation                    [+ New Session] ⋯  │
├────────────────────────────────────────────────────────┤
│  Active Context:                                       │
│  [📘 DDIA.pdf ✕]  [📄 Pages 42–45 ✕]  [🖍 "Replication..."]│
├────────────────────────────────────────────────────────┤
│  🤖 Reader AI                                          │
│  Leader-based replication ensures all mutations flow   │
│  through a single node before reaching replicas [p. 42]│
│                                                        │
│  [p. 42 • Chapter 5] ──▶ (Click jumps reader to p. 42) │
├────────────────────────────────────────────────────────┤
│  [Ask anything about this document...              ➤]  │
└────────────────────────────────────────────────────────┘
```


### Model picker and reasoning effort

The composer's model trigger shows a brain icon, the model name and, when the
conversation asked for one, a compact effort badge (`High`). Its accessible name
reads "AI model: *model*, *provider*, reasoning effort *level*". A saved level the
model no longer offers keeps its badge, marked stale ("no longer offered by this
model"); sending is refused with that explanation until the reader picks another
level or Default. The level is never changed silently.

The picker keeps search, provider groups and "Manage providers…". A model whose
provider published reasoning levels shows a 12px chevron at 65% opacity; the
selected row shows ✓ and a quiet level label. Choosing such a row opens a
**Reasoning effort** submenu (~184px, portalled beside the picker): Default
"Model decides", then the model's levels in canonical order with the hints Low
"Fastest", High "More thorough", Xhigh "Slower" and Max "Slowest". A row without
levels is chosen directly, at Default.

- **Commit.** Choosing a level commits model and level together, closes both
  menus and returns focus to the trigger. A plain model choice resets the level
  to Default. In a draft the choice is applied when the conversation is created.
- **Pointer.** Hover never selects. Resting on a row opens its levels after
  70ms; leaving them closes after a 300ms grace. A bridge and a 260ms safe
  triangle keep the levels open while the pointer travels diagonally to them
  across another row. Clicking a row pins its levels, and hover is then ignored.
  Touch never opens by hover.
- **Placement.** Right of the picker if it fits, else left, else nested in place.
  An 8px viewport clamp and a 4px gap apply; the flyout never covers the picker.
- **Keyboard.** ArrowRight (at the end of the search text) or Enter opens the
  levels and focuses the checked one. Up/Down, Home and End move through them,
  and Enter commits. ArrowLeft and Escape close one layer at a time.
- **Narrow fallback.** With no room on either side, the levels replace the list
  under a heading and a Back row named "*model*, back to models".
- The menu uses `menu`/`menuitemradio` with `aria-checked`, and no HTML is
  injected. It follows the active palette in light and dark, and its motion
  collapses under reduced motion.
---

## 6. Keyboard Shortcuts & Accessibility

| Shortcut (macOS / Windows) | Action Description |
|:---|:---|
| `Cmd/Ctrl + O` | Open file / Import document dialog |
| `Cmd/Ctrl + F` | Focus document text search |
| `Cmd/Ctrl + +` / `Cmd/Ctrl + -` | Zoom in / Zoom out reader viewport |
| `Cmd/Ctrl + 0` | Reset reader zoom to 100% |
| `Cmd/Ctrl + B` | Add bookmark at current reading position |
| `Cmd/Ctrl + Shift + A` | Toggle right-side AI Chat panel |
| `Cmd/Ctrl + Shift + N` | Toggle right-side Annotations browser |
| `F11` | Toggle Distraction-Free Focus Reading Mode |
| `Esc` | Exit Focus Mode / Close active modal / Dismiss floating toolbar |
| `Left` / `Right` | Reflowable ebook page navigation |

The `?` shortcut opens the discoverable in-app shortcut dialog. App-level commands are centralized and ignored for text inputs, textareas, selects, contenteditable controls, and repeated keydown events; F11 remains deterministic because it is handled as a desktop command rather than an editing shortcut.

### Interaction Accessibility Invariants

- Landmarks and heading order remain stable across panel layouts. Reading content is reachable before secondary chat/session details via a skip link.
- Dialogs/popovers trap focus only while modal, close predictably, and restore focus to the invoking control. Focus order follows visual order after panels resize or collapse.
- Streaming AI/agent text, indexing progress, errors, and completed actions use throttled polite live regions; urgent destructive-risk warnings use an assertive announcement without repeatedly interrupting reading.
- Focus Mode saves panel/focus state, moves focus into the reader, honors reduced motion, and restores both layout and focus on exit.
- UI reflows without horizontal two-dimensional scrolling at 200% zoom except intrinsically two-dimensional document/diff content, which receives its own labeled scroll region.
- Keyboard and assistive-technology behavior is tested in every palette, and all highlights/risk badges have text or icon equivalents.

---

## 7. Guided Onboarding (First Launch)

A genuinely new install opens a short, five-stage wizard once: Welcome, Discover,
Connect and choose defaults, Import, and a non-modal first-action tip. An
existing install is never interrupted; it is offered a dismissible entry point
instead, and setup stays available from Settings → General afterwards.

- **Nothing is a gate.** Reading, highlighting, notes and import require no AI
  provider and no account. *Continue* is never disabled by an unfinished check,
  and completion is reachable with no provider, no import and no tip.
- **Discovery is observation.** The Discover stage reuses the existing
  main-owned provider and agent-profile checks, one request per row, so a row
  renders the moment it settles and one slow runtime never blocks the others.
  Interleaf scans no network and no disk, starts no inference, and reads no
  credential file.
- **States stay distinct.** "API key not added", "No local server responding",
  "Not installed", "Signed out", "Installed — sign-in not verified",
  "Could not verify" and "Ready" are separate, truthful outcomes. An
  unsupported runtime is never described as ready, and uncertainty is shown as
  uncertainty rather than resolved optimistically.
- **Defaults are explicit.** Chat and agent defaults are confirmed separately by
  the user, never auto-picked, and apply only to new conversations and new
  agent drafts. Anything already open or running keeps the binding it was
  created with. Choosing a default grants no permission and starts no run.
- **Every exit is an exit.** The close button, Escape, *Skip AI setup*,
  *Start reading* and *Finish later* all stop the wizard reopening by itself.
  Only an involuntary exit — an OS quit or a crash — resumes, at the stage after
  the last one the user acted on.
- **Accessibility.** The wizard is a labelled modal dialog with a focus trap,
  keyboard operation throughout, and focus restored to the control that opened
  it or to the main content region when nothing did. Stage changes are announced
  politely. It reflows at 200% zoom and in the smallest supported window, and it
  uses only semantic palette tokens, so every palette applies. The first-action
  tip is a non-modal region beside a live document and is dismissible.

---

## 8. Design System: Spacing, Type, Radius, Dropdowns and Motion

`tests/unit/renderer-style-guards.spec.ts` guards these scales across
`src/renderer`. Each guard has an allow-list, and every entry carries a comment
giving its reason.

- **Spacing.** Use the 4px Tailwind scale; the 2px half-steps, such as
  `py-2.5`, are also allowed. Arbitrary pixel spacing (`p-[13px]`) is not.
- **Type.** Use only the 11, 12, 13, 14, 16 and 20px sizes. Arbitrary sizes
  are not allowed, except `em` sizes relative to surrounding document text.
  Field labels use sentence case at `text-xs font-medium text-text-secondary`.
  Monospace is reserved for code, paths, versions and model ids.
- **Radius.** Use 6px (`rounded`, `rounded-sm`), 8px (`md`), 12px (`lg`) and
  16px (`xl`), plus `rounded-full`. A nested radius equals the outer radius
  minus the padding between them.
- **Hover.** Hover styles apply only under `(hover: hover) and
  (pointer: fine)`, so touch input never leaves a control stuck in its hover
  state.
- **Dropdowns.** Every chrome dropdown is the themed `Select` listbox
  (`components/ui/select.tsx`), never a native `<select>`. It supports the
  full listbox keyboard contract, type-ahead and disabled options, and returns
  focus to its trigger. The Chat and Agent pickers share one trigger style.
- **Integrations.** Execution pickers, such as the Agent profile picker, offer
  only integrations that are installed. A stored choice that is no longer
  installed stays visible and is marked unavailable; it is never silently
  replaced. When nothing is installed, the picker shows an empty state that
  links to Settings. Settings → AI Providers lists ready integrations and those
  needing attention first, and collapses absent ones under
  "Not installed (n)".

### Motion

The durations are tokens in `tokens.css`:

| Token | Duration |
|:---|:---|
| `--dur-press` | 100ms |
| `--dur-exit` | 100ms |
| `--dur-fast` | 150ms |
| `--dur-base` | 200ms |
| `--dur-slow` | 280ms |

The easing curves are `--ease-out`, `--ease-in-out` and `--ease-drawer`. No
chrome transition runs longer than 300ms, and nothing animates `width`.

| Surface | Motion |
|:---|:---|
| Buttons | Scale to 0.97 while pressed (100ms); colour changes over 150ms |
| Popovers and menus | Fade and scale in from 0.96 over 150ms, from the trigger's edge |
| Dialogs (Settings, shortcuts, library and import dialogs) | Scrim fades, and the panel fades and scales from 0.98, over 200ms |
| Every exit | A 100ms fade (`--dur-exit`), opacity only. The leaving surface is `inert` and `aria-hidden` from the first frame, and focus moves on deliberately (back to the trigger, or onward on Tab) |
| Drawers | Slide over 280ms with `--ease-drawer` |
| Resizable panels | No animation while dragging. The width changes in one step; the content then fades in and slides 20px from its own edge over 200ms, and fades out over 100ms on close |
| Reader outline | Fades and slides 8px from its leading edge over 150ms |
| Theme change | 200ms cross-fade |
| Progress bar and toasts | The bar scales on the x-axis; toasts fade over 150–200ms |

Under `prefers-reduced-motion: reduce`:

- the global rule collapses transitions;
- `motion.css` removes all scaling and sliding, so only opacity can change;
- every spinner stops (`motion-reduce:animate-none`);
- dialogs and drawers open and close at once.
