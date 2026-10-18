// Progress calculation ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

export type FoliateTOCItem = {
  id?: number | string | undefined;
  label?: string | undefined;
  title?: string | undefined;
  href?: string | undefined;
  subitems?: FoliateTOCItem[] | undefined;
  children?: FoliateTOCItem[] | undefined;
};

const assignIDs = (toc: FoliateTOCItem[]): FoliateTOCItem[] => {
  let id = 0;
  const assignID = (item: FoliateTOCItem): void => {
    item.id = id++;
    const children = item.subitems ?? item.children;
    if (children) {
      for (const subitem of children) assignID(subitem);
    }
  };
  for (const item of toc) assignID(item);
  return toc;
};

const flatten = (items: FoliateTOCItem[]): FoliateTOCItem[] =>
  items
    .map((item) => {
      const children = item.subitems ?? item.children;
      return children && children.length > 0 ? [item, flatten(children)].flat() : item;
    })
    .flat();

export type FlattenedTOCEntry = {
  item: FoliateTOCItem;
  id: string;
  fragment: string | null;
};

export class TOCProgress {
  private ids: readonly string[] = [];
  private map = new Map<string, { prev: FoliateTOCItem | null; items: FlattenedTOCEntry[] | null }>();
  private getFragment?: ((doc: Document, id: string) => Element | null) | undefined;

  init({
    toc,
    ids,
    splitHref,
    getFragment,
  }: {
    readonly toc: FoliateTOCItem[];
    readonly ids: readonly string[];
    readonly splitHref: (href: string) => [string, string?];
    readonly getFragment?: (doc: Document, id: string) => Element | null;
  }): void {
    assignIDs(toc);
    const items = flatten(toc);
    const grouped = new Map<string, FlattenedTOCEntry[]>();

    for (const item of items) {
      if (!item.href) continue;
      const [id, fragment] = splitHref(item.href);
      if (!id) continue;
      const list = grouped.get(id) ?? [];
      list.push({ item, id, fragment: fragment ?? null });
      grouped.set(id, list);
    }

    let prev: FoliateTOCItem | null = null;
    this.map.clear();
    for (const id of ids) {
      const itemsForId = grouped.get(id) ?? null;
      this.map.set(id, { prev, items: itemsForId });
      if (itemsForId && itemsForId.length > 0) {
        prev = itemsForId.at(-1)?.item ?? prev;
      }
    }
    this.ids = ids;
    this.getFragment = getFragment;
  }

  getProgress(index: number, range?: Range | null): FoliateTOCItem | null {
    if (!this.ids.length) return null;
    const id = this.ids[index];
    if (!id) return null;
    const obj = this.map.get(id);
    if (!obj) return null;
    const { prev, items } = obj;
    if (!items || items.length === 0) return prev;
    if (!range || (items.length === 1 && !items[0]?.fragment)) {
      return items[0]?.item ?? null;
    }

    const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document);
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      if (!entry) continue;
      if (!entry.fragment) continue;
      const el = this.getFragment ? this.getFragment(doc, entry.fragment) : doc.getElementById(entry.fragment);
      if (!el) continue;
      if (range.comparePoint(el, 0) > 0) {
        return (items[i - 1]?.item ?? prev) ?? null;
      }
    }
    return items[items.length - 1]?.item ?? null;
  }
}

export type SectionInfo = {
  size?: number | undefined;
  linear?: string | undefined;
};

export class SectionProgress {
  private readonly sectionFractions: number[] = [];
  private readonly totalSize: number;

  constructor(
    private readonly sections: readonly SectionInfo[],
    private readonly sizePerLoc = 1500
  ) {
    let sum = 0;
    const sizes = sections.map((s) => {
      const size = s.linear === 'no' ? 0 : s.size ?? this.sizePerLoc;
      sum += size;
      return size;
    });
    this.totalSize = sum > 0 ? sum : sections.length * this.sizePerLoc;
    this.sectionFractions = sizes.map((s) => s / this.totalSize);
  }

  getProgress(index: number, fractionInSection = 0): number {
    if (this.sections.length === 0) return 0;
    let progress = 0;
    for (let i = 0; i < index && i < this.sectionFractions.length; i++) {
      progress += this.sectionFractions[i] ?? 0;
    }
    progress += (this.sectionFractions[index] ?? 0) * Math.max(0, Math.min(1, fractionInSection));
    return Math.max(0, Math.min(1, progress));
  }

  getSection(fraction: number): { index: number; fractionInSection: number } {
    const clamped = Math.max(0, Math.min(1, fraction));
    let sum = 0;
    for (let i = 0; i < this.sectionFractions.length; i++) {
      const sectionFrac = this.sectionFractions[i] ?? 0;
      if (sum + sectionFrac >= clamped) {
        const remaining = clamped - sum;
        const fractionInSection = sectionFrac > 0 ? remaining / sectionFrac : 0;
        return { index: i, fractionInSection: Math.max(0, Math.min(1, fractionInSection)) };
      }
      sum += sectionFrac;
    }
    return {
      index: Math.max(0, this.sections.length - 1),
      fractionInSection: 1,
    };
  }
}
