import type { PortableRecord } from '@shared/models/portable';

export type UpstreamMobiSection = {
  /** Upstream numbers its sections; `mobi.js` assigns `id: index`. */
  readonly id?: number;
  readonly size?: number;
  readonly linear?: string;
  readonly createDocument?: () => Promise<Document>;
  readonly load?: () => Promise<string>;
};

export type UpstreamMobiTocItem = {
  readonly label?: string;
  readonly title?: string;
  readonly href?: string;
  readonly subitems?: readonly UpstreamMobiTocItem[];
  readonly children?: readonly UpstreamMobiTocItem[];
};

export type UpstreamMobiTarget = {
  readonly index: number;
  readonly anchor?: (doc: Document) => Element | Range | null;
};

export type UpstreamMobiBook = {
  readonly sections: readonly UpstreamMobiSection[];
  readonly toc?: readonly UpstreamMobiTocItem[];
  readonly metadata?: PortableRecord;
  resolveHref?: (
    href: string
  ) => UpstreamMobiTarget | null | undefined | Promise<UpstreamMobiTarget | null | undefined>;
  destroy?: () => void;
};

export class MOBI {
  constructor(options: { readonly unzlib: (data: Uint8Array) => Promise<Uint8Array> });
  open(file: Blob): Promise<UpstreamMobiBook>;
}

export function isMOBI(file: Blob): Promise<boolean>;

export function addDecodedLength(total: number, next: number): number;
export function huffcdic(
  mobi: { readonly huffcdic: number; readonly numHuffcdic: number },
  loadRecord: (index: number) => Promise<ArrayBuffer>
): Promise<(data: Uint8Array) => Uint8Array>;
