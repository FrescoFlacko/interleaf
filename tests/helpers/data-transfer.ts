/**
 * A complete drag payload.
 *
 * jsdom does not construct `DataTransfer`, so a drag test builds the payload a
 * browser would have attached to the event. Everything the drag handlers touch
 * is real here: the declared MIME types, the data behind them, and the
 * negotiated `dropEffect` the handler writes back and the test then asserts on.
 * Files are never part of an in-app drag, so the file-backed members answer
 * empty rather than pretending to carry anything.
 */
export class TestDataTransfer implements DataTransfer {
  dropEffect: 'none' | 'copy' | 'link' | 'move' = 'none';
  effectAllowed: DataTransfer['effectAllowed'] = 'none';
  readonly files: FileList = emptyFileList();
  readonly items: DataTransferItemList = emptyItemList();

  private readonly entries: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  get types(): readonly string[] {
    return [...this.entries.keys()];
  }

  getData(format: string): string {
    return this.entries.get(format) ?? '';
  }

  setData(format: string, data: string): void {
    this.entries.set(format, data);
  }

  clearData(format?: string): void {
    if (format === undefined) this.entries.clear();
    else this.entries.delete(format);
  }

  setDragImage(): void {
    /* no drag image is painted in jsdom */
  }
}

function emptyFileList(): FileList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: () => [][Symbol.iterator](),
  };
}

function emptyItemList(): DataTransferItemList {
  return {
    length: 0,
    add: () => null,
    clear: () => undefined,
    remove: () => undefined,
    [Symbol.iterator]: () => [][Symbol.iterator](),
  };
}
