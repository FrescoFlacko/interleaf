import { useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useUiStore } from "../stores/use-ui-store";
import type { RightTab } from "../types/ui";
import { AgentComposer } from "../features/agent/AgentComposer";
import { AnnotationBrowser } from "../features/annotations/AnnotationBrowser";
import { SearchPanel } from "../features/search/SearchPanel";
import { ChatPanel } from "../features/chat/ChatPanel";
import "./companion-text.css";

const TABS: readonly { id: RightTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "search", label: "Search" },
  { id: "annotations", label: "Annotations" },
  { id: "agent", label: "Agent" },
];

/**
 * AI Chat, Annotations and Agent draw their own full-bleed canvas: fixed
 * headers, hairlines and pinned action bars have to reach the panel edge, so
 * each insets its own content by the shared 16 px gutter. The panel yields its
 * padding to them rather than adding a second inset on top of theirs, and it
 * owns that decision so no tab-only style has to reach across the shared tab
 * bar to make it. Search has no such surface and takes the panel's padding.
 */
const CONTENT_PADDING: Record<RightTab, string> = {
  chat: "p-0",
  search: "p-4",
  annotations: "p-0",
  agent: "p-0",
};

export function CompanionPanel() {
  const rightTab = useUiStore((state) => state.rightTab);
  const setRightTab = useUiStore((state) => state.setRightTab);
  const companionTextSize = useUiStore((state) => state.companionTextSize);
  const tabRefs = useRef<Record<RightTab, HTMLButtonElement | null>>({
    chat: null,
    search: null,
    annotations: null,
    agent: null,
  });

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === rightTab);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + delta + TABS.length) % TABS.length];
    if (!next) {
      return;
    }
    setRightTab(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <aside
      data-testid="companion-panel"
      id="companion-panel"
      data-active-tab={rightTab}
      aria-label="Companion"
      /* One custom property carries the readable-text preference to both tabs.
         Nothing reads it except the `.companion-readable` sizes, so raising it
         cannot move a control or a hit target. */
      style={{ '--companion-text-scale': companionTextSize } as CSSProperties}
      className="flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden bg-bg-primary"
    >
      {/* At the sidebar's 280 px minimum the four labels together need more
          room than equal thirds of it, so the bar stops distributing width and
          starts respecting the labels: each tab keeps its text on one line and
          takes an 8 px inset on each side. Below 22rem of bar — which is every
          width from the 280 px minimum up to and including the default column,
          where the four labels at their full size overflowed and "Agent" was
          cut off — the tabs take the smaller type, tighter tracking and the
          4 px half-step inset instead, so all four stay whole and clickable
          rather than one of them sitting outside the visible strip. The
          8 px inset and the four labels cannot both fit there: at the 280 px
          minimum the row needs 250 px of a 222 px strip even at the smaller
          type, and a tab nobody can reach is the worse of the two.
          The row still scrolls horizontally if even
          that does not fit — a wider system font — rather than wrapping or
          clipping a label. The scrollbar is hidden because a visible gutter
          would cost more of this column's width than it explains; keyboard
          arrows already move between the tabs and bring the focused one into
          view. */}
      {/* The row's height is declared, not inherited from the tabs inside it:
          the reader header beside it reads the same value, which is what keeps
          the two dividers on one line. The value is the height these tabs
          already had, so the bar itself is unchanged. */}
      <div className="@container flex h-[var(--workspace-header-row-height)] shrink-0 items-center border-b border-border-subtle">
        <div
          role="tablist"
          aria-label="Companion panels"
          className="companion-tablist flex min-w-0 flex-1 overflow-x-auto"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              type="button"
              role="tab"
              id={`companion-tab-${tab.id}`}
              aria-selected={rightTab === tab.id}
              aria-controls={`companion-panel-${tab.id}`}
              tabIndex={rightTab === tab.id ? 0 : -1}
              onKeyDown={handleTabKeyDown}
              onClick={() => { setRightTab(tab.id); }}
              className={
                "flex-1 px-2 py-2.5 text-sm font-medium whitespace-nowrap transition-colors " +
                "@max-[22rem]:px-1 @max-[22rem]:text-xs @max-[22rem]:tracking-tight " +
                (rightTab === tab.id
                  ? "border-b-2 border-accent text-accent"
                  : "border-b-2 border-transparent text-text-secondary hover:text-text-primary")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div
        data-testid="companion-panel-content"
        className={"flex flex-1 min-h-0 flex-col overflow-hidden " + CONTENT_PADDING[rightTab]}
      >
        <div
          role="tabpanel"
          id="companion-panel-search"
          data-testid="companion-panel-search"
          aria-labelledby="companion-tab-search"
          hidden={rightTab !== "search"}
          className={rightTab === "search" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : undefined}
        >
          <SearchPanel />
        </div>

        <div
          role="tabpanel"
          id="companion-panel-chat"
          data-testid="companion-panel-chat"
          aria-labelledby="companion-tab-chat"
          hidden={rightTab !== "chat"}
          className={rightTab === "chat" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : undefined}
        >
          <ChatPanel />
        </div>

        <div
          role="tabpanel"
          id="companion-panel-annotations"
          data-testid="companion-panel-annotations"
          aria-labelledby="companion-tab-annotations"
          hidden={rightTab !== "annotations"}
          className={rightTab === "annotations" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : undefined}
        >
          <AnnotationBrowser />
        </div>

        <div
          role="tabpanel"
          id="companion-panel-agent"
          data-testid="companion-panel-agent"
          aria-labelledby="companion-tab-agent"
          hidden={rightTab !== "agent"}
          className={rightTab === "agent" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : undefined}
        >
          <AgentComposer />
        </div>
      </div>
    </aside>
  );
}
