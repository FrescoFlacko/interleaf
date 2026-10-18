// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMermaidFigure,
  describeDiagramKind,
  detectAppearance,
  paintDiagram,
  showDiagramNote,
  syncDiagramScrollAffordance,
} from '../../src/renderer/features/reader/adapters/mermaid-block';

function figure(): { region: HTMLElement; note: HTMLElement; figure: HTMLElement } {
  const pre = document.createElement('pre');
  return createMermaidFigure(3, pre);
}

/** jsdom has no layout, so the box is told what size it and its picture are. */
function sizeRegion(
  region: HTMLElement,
  box: { client: number; scroll: number },
  axis: 'width' | 'height' = 'width'
): void {
  const client = axis === 'width' ? 'clientWidth' : 'clientHeight';
  const scroll = axis === 'width' ? 'scrollWidth' : 'scrollHeight';
  Object.defineProperty(region, client, { configurable: true, value: box.client });
  Object.defineProperty(region, scroll, { configurable: true, value: box.scroll });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('diagram naming', () => {
  it.each([
    ['flowchart TD\n A-->B', 'Flowchart'],
    ['graph LR\n A-->B', 'Flowchart'],
    ['sequenceDiagram\n A->>B: hi', 'Sequence diagram'],
    ['classDiagram\n A <|-- B', 'Class diagram'],
    ['stateDiagram-v2\n [*] --> A', 'State diagram'],
    ['erDiagram\n A ||--o{ B : has', 'Entity relationship diagram'],
    ['\n\n  gantt\n title X', 'Gantt chart'],
  ])('names %s', (source, expected) => {
    expect(describeDiagramKind(source)).toBe(expected);
  });

  it('never echoes document text into the accessible label', () => {
    expect(describeDiagramKind('flowchart TD %% secret-token-abc')).toBe('Flowchart');
    expect(describeDiagramKind('totallyMadeUpDiagram\n A-->B')).toBe('Diagram');
  });
});

describe('oversized diagrams are reachable from the keyboard', () => {
  it('becomes a named, focusable region only while it actually overflows', () => {
    const { region } = figure();
    paintDiagram(region, { status: 'rendered', svg: '<svg/>', width: 400, height: 40 }, 'Flowchart');

    sizeRegion(region, { client: 100, scroll: 400 });
    syncDiagramScrollAffordance(region, 'Flowchart');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Flowchart, scrollable');

    // A reflow that makes the picture fit must take the tab stop away again,
    // rather than leaving a stop that announces scrolling that cannot happen.
    sizeRegion(region, { client: 400, scroll: 400 });
    syncDiagramScrollAffordance(region, 'Flowchart');
    expect(region.hasAttribute('tabindex')).toBe(false);
    expect(region.hasAttribute('role')).toBe(false);
    expect(region.hasAttribute('aria-label')).toBe(false);
  });

  it('treats a tall diagram the same as a wide one', () => {
    const { region } = figure();
    sizeRegion(region, { client: 100, scroll: 900 }, 'height');
    syncDiagramScrollAffordance(region, 'Sequence diagram');
    expect(region.getAttribute('aria-label')).toBe('Sequence diagram, scrollable');
  });

  it('is not a tab stop when there is no picture to scroll', () => {
    const { region, note } = figure();
    sizeRegion(region, { client: 100, scroll: 400 });
    showDiagramNote(region, note, 'This diagram could not be drawn.');

    syncDiagramScrollAffordance(region, 'Flowchart');
    expect(region.hidden).toBe(true);
    expect(region.hasAttribute('tabindex')).toBe(false);
  });

  it('marks the box busy until it has something in it', () => {
    const { region } = figure();
    expect(region.getAttribute('aria-busy')).toBe('true');
    paintDiagram(region, { status: 'rendered', svg: '<svg/>', width: 10, height: 10 }, 'Flowchart');
    expect(region.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('appearance follows the surface a diagram is read against', () => {
  it('reads the nearest painted background rather than a theme name', () => {
    const page = document.createElement('div');
    const wrapper = document.createElement('div');
    page.appendChild(wrapper);
    document.body.appendChild(page);

    page.style.backgroundColor = 'rgb(255, 255, 255)';
    expect(detectAppearance(wrapper)).toBe('light');

    page.style.backgroundColor = 'rgb(20, 22, 24)';
    expect(detectAppearance(wrapper)).toBe('dark');

    // A reader background set independently of the palette still decides.
    wrapper.style.backgroundColor = 'rgb(250, 244, 226)';
    expect(detectAppearance(wrapper)).toBe('light');
  });

  it('looks past a transparent surface for the colour actually behind it', () => {
    const page = document.createElement('div');
    const wrapper = document.createElement('div');
    page.appendChild(wrapper);
    document.body.appendChild(page);
    page.style.backgroundColor = 'rgb(18, 18, 18)';
    wrapper.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';

    expect(detectAppearance(wrapper)).toBe('dark');
  });

  it('defaults to the light appearance when nothing is painted', () => {
    expect(detectAppearance(null)).toBe('light');
  });
});
