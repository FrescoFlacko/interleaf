import { expect, type Locator } from '@playwright/test';

/**
 * Geometry of the chat composer and the attached-context row above it, read
 * from the real window.
 *
 * The reported defect is a layout one — with several page contexts pinned, the
 * composer's controls stop lining up — so the evidence has to come from a
 * browser that actually lays out. These functions are shared so a spec can take
 * the same reading at more than one width or zoom and compare them against one
 * definition of "aligned".
 *
 * Every measurement is taken *inside* a caller-supplied region, and the region
 * is checked against the viewport first. Narrow layouts move Chat from the
 * docked companion panel into a drawer that slides in over the reader, and
 * during that slide the panel is mounted, laid out, and entirely off-screen. A
 * global `document.querySelector` would happily measure it and report a tidy
 * row nobody can see, so `surface` below exists to make that a failure rather
 * than a pass.
 */

type ComposerAlignment = {
  /** The Chat region itself: where it sits relative to the viewport. */
  readonly surface: {
    readonly visible: boolean;
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly viewportWidth: number;
  };
  readonly panelOverflowX: number;
  readonly composerOverflowX: number;
  readonly chipRows: number;
  readonly chipCount: number;
  readonly chipsOutside: number;
  readonly chipsClipped: number;
  readonly toolbarControls: readonly {
    readonly label: string;
    /** Width the wrapper paints beyond the control it holds. */
    readonly slack: number;
    readonly centerY: number;
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly insideComposer: boolean;
    /** The control's own label does not fit the box painted for it. */
    readonly labelClipped: boolean;
  }[];
  readonly sendTop: number;
  readonly sendBottom: number;
  readonly sendInside: boolean;
  readonly rowGaps: readonly number[];
};

/**
 * Reads the composer inside `region`, which must be the Chat region the reader
 * is actually looking at.
 */
export async function measureComposerAlignment(region: Locator): Promise<ComposerAlignment> {
  return region.evaluate((root: HTMLElement) => {
    const panel = root.closest<HTMLElement>('[data-testid="companion-panel"], [data-testid="compact-drawer-right"]') ?? root;
    const composer = root.querySelector<HTMLElement>('.chat-design-composer');
    const list = root.querySelector<HTMLElement>('[data-testid="chat-context-list"]');
    const toolbar = root.querySelector<HTMLElement>('.chat-design-controls');
    const send = root.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
    if (!composer || !list || !toolbar || !send) {
      throw new Error('The chat composer and its context row were not both mounted in this region.');
    }
    const panelRect = panel.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const chips = [...list.querySelectorAll<HTMLElement>('.chat-design-chip')];
    // The tool row ends with Send, which is measured on its own below.
    const controls = [...toolbar.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== send);
    const rects = controls.map((control) => control.getBoundingClientRect());
    return {
      surface: {
        visible: panel.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        left: panelRect.left,
        right: panelRect.right,
        width: panelRect.width,
        viewportWidth: window.innerWidth,
      },
      panelOverflowX: panel.scrollWidth - panel.clientWidth,
      composerOverflowX: composer.scrollWidth - composer.clientWidth,
      // Wrapped rather than scrolled sideways: distinct top edges are rows.
      chipRows: new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
      chipCount: chips.length,
      chipsOutside: chips.filter((chip) => {
        const rect = chip.getBoundingClientRect();
        return rect.right > listRect.right + 1 || rect.left < listRect.left - 1;
      }).length,
      chipsClipped: chips.filter((chip) => chip.getBoundingClientRect().height < 8).length,
      toolbarControls: controls.map((control, index) => {
        const rect = rects[index]!;
        // A wrapper around a control must be exactly as wide as the control; an
        // icon button is itself the control, and its square hit target is
        // deliberately larger than the glyph inside it.
        const inner = control.tagName === 'BUTTON'
          ? rect
          : (control.firstElementChild ?? control).getBoundingClientRect();
        // The element that actually carries the words, measured against the
        // width its own text wants: `scrollWidth` reports nothing useful for
        // an ellipsized inline box, so the text itself is measured, as
        // rendered: a part the layout hides on purpose is not clipped.
        const text = control.querySelector<HTMLElement>('span') ?? control;
        const probe = document.createElement('span');
        const textStyle = window.getComputedStyle(text);
        probe.textContent = text.innerText;
        probe.style.fontFamily = textStyle.fontFamily;
        probe.style.fontSize = textStyle.fontSize;
        probe.style.fontWeight = textStyle.fontWeight;
        probe.style.letterSpacing = textStyle.letterSpacing;
        probe.style.whiteSpace = 'nowrap';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        document.body.append(probe);
        const naturalWidth = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          label: control.textContent.trim() || (control.getAttribute('aria-label') ?? 'icon control'),
          labelClipped: naturalWidth > text.getBoundingClientRect().width + 1,
          slack: rect.width - inner.width,
          centerY: rect.top + rect.height / 2,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          insideComposer: rect.left >= composerRect.left - 1 && rect.right <= composerRect.right + 1,
        };
      }),
      sendTop: sendRect.top,
      sendBottom: sendRect.bottom,
      sendInside: sendRect.right <= composerRect.right + 1 && sendRect.left >= composerRect.left - 1,
      // Space between adjacent controls, which is the row's own gap and not
      // reserved width inside a control.
      rowGaps: rects.slice(1).map((rect, index) => rect.left - rects[index]!.right),
    };
  });
}

/** Everything the reported defect broke, checked against one reading. */
export function expectComposerAligned(metrics: ComposerAlignment, label: string): void {
  // First: is this surface the one the reader can see? A drawer mid-slide lays
  // out perfectly and sits entirely outside the viewport.
  const { surface } = metrics;
  expect(surface.visible, `${label}: the measured Chat surface must be visible`).toBe(true);
  expect(surface.width, `${label}: the measured Chat surface must have width`).toBeGreaterThan(0);
  expect(surface.left, `${label}: the Chat surface must start inside the viewport`)
    .toBeLessThan(surface.viewportWidth);
  expect(surface.right, `${label}: the Chat surface must reach into the viewport`).toBeGreaterThan(0);
  expect(surface.right - Math.max(surface.left, 0), `${label}: the Chat surface is almost entirely off-screen`)
    .toBeGreaterThan(surface.width / 2);

  expect(metrics.panelOverflowX, `${label}: the companion panel must not overflow sideways`).toBeLessThanOrEqual(1);
  expect(metrics.composerOverflowX, `${label}: the composer must not overflow sideways`).toBeLessThanOrEqual(1);
  expect(metrics.chipRows, `${label}: the chips must wrap onto more than one row`).toBeGreaterThan(1);
  expect(metrics.chipsOutside, `${label}: no chip may hang outside its row`).toBe(0);
  expect(metrics.chipsClipped, `${label}: no chip may be collapsed to nothing`).toBe(0);

  const [first, ...rest] = metrics.toolbarControls;
  expect(first, `${label}: the control row must hold controls`).toBeDefined();
  for (const control of rest) {
    // One row, one centre line: nothing sits high or low against the rest.
    expect(Math.abs(control.centerY - first!.centerY), `${label}: "${control.label}" is off the control row`)
      .toBeLessThanOrEqual(1);
  }
  for (const control of metrics.toolbarControls) {
    expect(control.slack, `${label}: "${control.label}" is painted wider than its own content`).toBeLessThanOrEqual(1);
    expect(control.insideComposer, `${label}: "${control.label}" is clipped by the composer edge`).toBe(true);
    // Send shares the row rather than sitting above or below it.
    const overlap = Math.min(metrics.sendBottom, control.bottom) - Math.max(metrics.sendTop, control.top);
    expect(overlap, `${label}: Send does not share a line with "${control.label}"`).toBeGreaterThan(0);
  }
  // No control may sit on top of the one before it.
  for (const [index, control] of rest.entries()) {
    const previous = metrics.toolbarControls[index]!;
    expect(control.left, `${label}: "${control.label}" overlaps "${previous.label}"`)
      .toBeGreaterThanOrEqual(previous.right - 1);
  }
  // Equal, deliberate spacing between the controls.
  const gaps = metrics.rowGaps.map((gap) => Math.round(gap));
  for (const gap of gaps) expect(gap, `${label}: uneven spacing in the control row`).toBe(gaps[0]);
  expect(metrics.sendInside, `${label}: Send must stay inside the composer`).toBe(true);
}

/**
 * A control whose label must still read as a word.
 *
 * A long name ellipsizing in a narrow row is deliberate; a short one clipped
 * mid-glyph is the row running out of room in the wrong place, and it leaves
 * the reader unable to tell which provider the conversation is bound to.
 */
export function expectLabelIntact(metrics: ComposerAlignment, wanted: string, label: string): void {
  const control = metrics.toolbarControls.find((candidate) => candidate.label.includes(wanted));
  expect(control, `${label}: no control carries "${wanted}"`).toBeDefined();
  expect(control!.labelClipped, `${label}: "${wanted}" is clipped rather than shown`).toBe(false);
}

/** The controls the reported row is made of, by their visible text. */
export function expectComposerRowContains(
  metrics: ComposerAlignment,
  expected: readonly string[],
  label: string,
): void {
  const labels = metrics.toolbarControls.map((control) => control.label);
  for (const wanted of expected) {
    expect(labels.some((actual) => actual.includes(wanted)), `${label}: "${wanted}" is missing from ${JSON.stringify(labels)}`)
      .toBe(true);
  }
}
