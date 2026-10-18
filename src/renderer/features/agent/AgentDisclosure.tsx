import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import { useOverlayDismissal } from './use-outside-dismiss';

type AgentDisclosureProps = {
  /** Id of the controlled region; must be unique in the rendered tree. */
  readonly regionId: string;
  /** Visible trigger text, and the block's accessible name. */
  readonly label: string;
  /**
   * When the block was previously labelled by a heading, pass that heading's
   * id: the trigger is wrapped in the heading so the section it labels keeps
   * its `aria-labelledby` target and its place in the heading outline.
   */
  readonly headingId?: string;
  readonly containerClassName?: string;
  readonly testId?: string;
  /**
   * Set when the region is an overlay anchored to the trigger rather than an
   * inline section. An overlay covers what is behind it, so a press outside it
   * and Escape both close it; an inline section keeps its content in the flow
   * and dismisses only through its own trigger.
   */
  readonly overlay?: boolean;
  /** Class of the region itself; an overlay's region is its popover surface. */
  readonly regionClassName?: string;
  readonly children: ReactNode;
};

type Presence = ReturnType<typeof usePopoverPresence>;

/**
 * An overlay's region stays visible, inert, through its exit fade and sits at
 * its trigger's fixed coordinates; an inline section just hides in the flow.
 */
function regionAttributes(overlay: boolean, expanded: boolean, presence: Presence, anchorStyle: CSSProperties) {
  if (!overlay) return { hidden: !expanded };
  return { hidden: !presence.present, style: anchorStyle, ...phaseAttributes(presence.phase) };
}

function DisclosureTrigger({ triggerRef, regionId, label, expanded, onToggle }: {
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly regionId: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={regionId}
      onClick={onToggle}
      // The same label recipe as `CardLabel`, so "Review" and "Run details"
      // read as one kind of section heading.
      className="flex w-full items-center gap-1 rounded text-left text-xs font-medium text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
    >
      <AppIcon name={expanded ? 'disclosure-expanded' : 'disclosure-collapsed'} size={12} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

/**
 * Collapsible block for the agent panel, lifting the activity list's
 * show/hide idiom up to the review and session sections.
 *
 * The region stays mounted and is hidden with the `hidden` attribute rather
 * than unmounted, so `aria-controls` always resolves to a real element — which
 * is what the ARIA disclosure pattern requires — and so the collapsed content
 * is still one Find-in-page away.
 */
export function AgentDisclosure({
  regionId,
  label,
  headingId,
  containerClassName,
  testId,
  overlay,
  regionClassName,
  children,
}: AgentDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const isOverlay = overlay === true;
  // An overlay stays visible, inert, through its 100ms exit fade.
  const presence = usePopoverPresence(isOverlay && expanded);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  // An overlay takes fixed coordinates from its trigger, so the companion's
  // edge cannot clip it; an inline section stays in the flow.
  const anchorStyle = useAnchoredPosition(triggerRef, regionRef, 'bottom');
  const handleOverlayKeyDown = useOverlayDismissal({ overlay, expanded, setExpanded, containerRef, triggerRef });

  const trigger = (
    <DisclosureTrigger
      triggerRef={triggerRef}
      regionId={regionId}
      label={label}
      expanded={expanded}
      onToggle={() => { setExpanded((current) => !current); }}
    />
  );

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      data-testid={testId}
      onKeyDown={handleOverlayKeyDown}
    >
      {headingId === undefined ? trigger : <h3 id={headingId}>{trigger}</h3>}
      <div
        ref={regionRef}
        id={regionId}
        className={regionClassName}
        {...regionAttributes(isOverlay, expanded, presence, anchorStyle)}
      >
        {children}
      </div>
    </div>
  );
}
