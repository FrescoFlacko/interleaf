import { inflateZipArchive } from './foliate/zip-inflate-core';
import { isSafeArchivePath } from './foliate/zip-loader-limits';
import { SaxesParser, type SaxesTagNS } from 'saxes';

/**
 * Format-neutral OOXML package handling shared by the DOCX and PPTX parsers.
 *
 * Every helper takes the package kind so a failure names the format the reader
 * opened. The active-content policy is the same for both formats: macros,
 * ActiveX, OLE/package objects, custom UI and audio/video fail closed, and
 * external relationships are recorded but never materialized.
 */
export type OoxmlKind = 'DOCX' | 'PPTX';

export type OoxmlRelationship = {
  readonly target: string;
  readonly external: boolean;
  readonly isImage: boolean;
  readonly type: string;
};

const CONTENT_TYPES_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://purl.oclc.org/ooxml/package/content-types',
]);
const RELATIONSHIPS_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);
const CONTENT_TYPE_ENTRY_NAMES: ReadonlySet<string> = new Set(['Default', 'Override']);
const RELATIONSHIP_ENTRY_NAMES: ReadonlySet<string> = new Set(['Relationship']);
const ACTIVE_CONTENT_PATTERN = /macroenabled|vbaproject|activex|oleobject|attachedtoolbars|customui|officedocument\.package/i;
const INTERACTIVE_MEDIA_CONTENT_TYPE_PATTERN = /^(?:audio|video)\//i;
const INTERACTIVE_MEDIA_RELATIONSHIP_PATTERN = /\/(?:audio|video|media)$/i;
const INTERACTIVE_MEDIA_ENTRY_PATTERN = /\.(?:aac|avi|flac|m4a|mov|mp3|mp4|oga|ogg|ogv|wav|webm|wmv)$/i;

function activeContentError(kind: OoxmlKind): Error {
  return new Error(`This ${kind} contains unsupported active or embedded content.`);
}

function isOoxmlError(error: Error, kind: OoxmlKind): boolean {
  return error.message.startsWith(`Invalid ${kind}`) || error.message.startsWith(`This ${kind}`);
}

function saxAttribute(tag: SaxesTagNS, localName: string): string {
  return Object.values(tag.attributes).find(
    (attribute) => attribute.local === localName && attribute.uri === ''
  )?.value ?? '';
}

type SaxPartSpec = {
  readonly kind: OoxmlKind;
  readonly label: string;
  readonly namespaceLabel: string;
  readonly rootLocal: string;
  readonly namespaces: ReadonlySet<string>;
  readonly childLocals: ReadonlySet<string>;
  readonly onChild: (tag: SaxesTagNS) => void;
};

function assertNoDeclarations(source: string, kind: OoxmlKind, label: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new Error(`Invalid ${kind}: forbidden declaration in ${label}`);
  }
}

/**
 * Streams a package part, requiring the expected namespaced root and handing
 * each namespaced child of interest to `onChild`. Package policy errors
 * propagate unchanged; any other parse failure reports the part as malformed.
 */
function walkSaxPart(source: string, spec: SaxPartSpec): void {
  const { kind } = spec;
  assertNoDeclarations(source, kind, spec.label);
  const namespaceError = (): Error => new Error(`Invalid ${kind}: malformed ${spec.namespaceLabel} namespace`);
  const state = { rootSeen: false };
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (!state.rootSeen) {
      state.rootSeen = true;
      if (tag.local !== spec.rootLocal || !spec.namespaces.has(tag.uri)) throw namespaceError();
      return;
    }
    if (!spec.childLocals.has(tag.local)) return;
    if (!spec.namespaces.has(tag.uri)) throw namespaceError();
    spec.onChild(tag);
  });
  try {
    parser.write(source).close();
    if (!state.rootSeen) throw new Error(`Invalid ${kind}: missing ${spec.label} root`);
  } catch (error) {
    if (error instanceof Error && isOoxmlError(error, kind)) throw error;
    throw new Error(`Invalid ${kind}: malformed ${spec.label}`, { cause: error });
  }
}

function isActiveContentType(contentType: string): boolean {
  return ACTIVE_CONTENT_PATTERN.test(contentType) || INTERACTIVE_MEDIA_CONTENT_TYPE_PATTERN.test(contentType);
}

export function inspectContentTypes(source: string, kind: OoxmlKind): ReadonlySet<string> {
  const contentTypes = new Set<string>();
  walkSaxPart(source, {
    kind,
    label: '[Content_Types].xml',
    namespaceLabel: 'content-types',
    rootLocal: 'Types',
    namespaces: CONTENT_TYPES_NAMESPACES,
    childLocals: CONTENT_TYPE_ENTRY_NAMES,
    onChild: (tag) => {
      const contentType = saxAttribute(tag, 'ContentType');
      if (!contentType) throw new Error(`Invalid ${kind}: content type is missing`);
      if (isActiveContentType(contentType)) throw activeContentError(kind);
      contentTypes.add(contentType.toLowerCase());
    },
  });
  return contentTypes;
}

const ACTIVE_RELATIONSHIP_TYPE_PATTERN = /\/(?:vbaproject|activex(?:control|controlbinary)?|control|oleobject|package|attachedtoolbars|customui|ui\/extensibility)$/i;

function isActiveRelationshipType(type: string): boolean {
  return [ACTIVE_RELATIONSHIP_TYPE_PATTERN, INTERACTIVE_MEDIA_RELATIONSHIP_PATTERN, ACTIVE_CONTENT_PATTERN]
    .some((pattern) => pattern.test(type));
}

export function normalizedLocalName(node: { readonly localName: string }): string {
  const separator = node.localName.lastIndexOf(':');
  return separator >= 0 ? node.localName.slice(separator + 1) : node.localName;
}

export function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  return Array.from(root.querySelectorAll('*')).filter(
    (element) => normalizedLocalName(element) === localName
  );
}

export function directChildrenByLocalName(root: Element, localName: string): Element[] {
  return Array.from(root.children).filter((element) => normalizedLocalName(element) === localName);
}

export function firstDescendant(root: Document | Element, localName: string): Element | undefined {
  return elementsByLocalName(root, localName)[0];
}

export function attributeByLocalName(element: Element | undefined, localName: string): string {
  if (!element) return '';
  const attribute = Array.from(element.attributes).find(
    (candidate) => normalizedLocalName(candidate) === localName
  );
  return attribute?.value ?? '';
}

export function parseXml(source: string, label: string, kind: OoxmlKind): Document {
  assertNoDeclarations(source, kind, label);
  try {
    new SaxesParser({ xmlns: true }).write(source).close();
  } catch (error) {
    throw new Error(`Invalid ${kind}: malformed ${label}`, { cause: error });
  }
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error(`Invalid ${kind}: malformed ${label}`);
  return document;
}

/** Decodes XML text by its byte-order mark, defaulting to UTF-8; throws on malformed text. */
function decodeXmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function readBoundedXml(
  entries: ReadonlyMap<string, Uint8Array>,
  path: string,
  maxBytes: number,
  kind: OoxmlKind
): string | null {
  const bytes = entries.get(path.toLowerCase());
  if (!bytes) return null;
  if (bytes.byteLength > maxBytes) throw new Error(`Invalid ${kind}: ${path} exceeds safety limit`);
  try {
    return decodeXmlText(bytes);
  } catch (error) {
    throw new Error(`Invalid ${kind}: ${path} uses malformed text encoding`, { cause: error });
  }
}

function decodeTarget(target: string): string | null {
  try {
    return decodeURIComponent(target).replaceAll('\\', '/');
  } catch {
    return null;
  }
}

/** Applies path segments to `parts`, refusing to climb at or above `floor`; `false` means an escape. */
function applySegments(parts: string[], path: string, floor: number): boolean {
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (parts.length <= floor) return false;
      parts.pop();
    } else if (segment && segment !== '.') {
      parts.push(segment);
    }
  }
  return true;
}

/** Resolves a package-internal relationship target against the source part's directory. */
function normalizeRelationshipTarget(
  target: string,
  baseDirectory: string,
  allowRootRelative = false
): string | null {
  const normalized = decodeTarget(target);
  if (normalized === null || /^[a-z][a-z\d+.-]*:/i.test(normalized)) return null;
  const rootRelative = normalized.startsWith('/');
  if (rootRelative && !allowRootRelative) return null;
  const parts = rootRelative ? [] : baseDirectory.split('/').filter(Boolean);
  if (!applySegments(parts, normalized, rootRelative ? 0 : 1)) return null;
  const path = parts.join('/');
  return path && isSafeArchivePath(path) ? path : null;
}

type RelationshipOptions = {
  readonly collectDocumentResources: boolean;
  readonly label: string;
  readonly kind: OoxmlKind;
  readonly baseDirectory: string;
  /** Only DOCX historically refuses root-relative targets; PPTX packages use them legitimately. */
  readonly allowRootRelative?: boolean;
};

function relationshipTarget(target: string, external: boolean, options: RelationshipOptions): string {
  const normalized = external
    ? target
    : normalizeRelationshipTarget(target, options.baseDirectory, options.allowRootRelative === true);
  if (!normalized) throw new Error(`Invalid ${options.kind}: unsafe relationship target`);
  return normalized;
}

function recordRelationship(
  tag: SaxesTagNS,
  options: RelationshipOptions,
  relationships: Map<string, OoxmlRelationship>
): void {
  const { kind } = options;
  const id = saxAttribute(tag, 'Id');
  const target = saxAttribute(tag, 'Target');
  const type = saxAttribute(tag, 'Type');
  if (!id || !target || !type) throw new Error(`Invalid ${kind}: incomplete relationship`);
  if (isActiveRelationshipType(type)) throw activeContentError(kind);
  if (!options.collectDocumentResources) return;
  if (relationships.has(id)) throw new Error(`Invalid ${kind}: duplicate relationship identifier`);
  const external = saxAttribute(tag, 'TargetMode').toLowerCase() === 'external';
  relationships.set(id, {
    target: relationshipTarget(target, external, options),
    external,
    isImage: /\/image$/i.test(type),
    type,
  });
}

export function parseRelationships(
  source: string | null,
  options: RelationshipOptions
): Map<string, OoxmlRelationship> {
  const relationships = new Map<string, OoxmlRelationship>();
  if (!source) return relationships;
  walkSaxPart(source, {
    kind: options.kind,
    label: options.label,
    namespaceLabel: options.label,
    rootLocal: 'Relationships',
    namespaces: RELATIONSHIPS_NAMESPACES,
    childLocals: RELATIONSHIP_ENTRY_NAMES,
    onChild: (tag) => { recordRelationship(tag, options, relationships); },
  });
  return relationships;
}

const ACTIVE_ENTRY_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)vbaproject\.bin$/i,
  /(?:^|\/)activex\//i,
  /(?:^|\/)embeddings\//i,
  INTERACTIVE_MEDIA_ENTRY_PATTERN,
];

function isActiveEntryPath(path: string): boolean {
  return ACTIVE_ENTRY_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Inflates an OOXML package under the caller's zip-bomb limits and refuses
 * duplicate entries and any part whose path marks it as active or media content.
 */
export function openOoxmlPackage(
  bytes: Uint8Array,
  kind: OoxmlKind,
  limits: {
    readonly maxEntries: number;
    readonly maxTotalUncompressedBytes: number;
    readonly maxSingleEntryBytes: number;
    readonly maxContentTypesBytes: number;
  }
): { readonly entries: ReadonlyMap<string, Uint8Array>; readonly contentTypes: string | null } {
  const inflated = inflateZipArchive(bytes, {
    maxEntries: limits.maxEntries,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
    maxSingleEntryBytes: limits.maxSingleEntryBytes,
  });
  const entries = new Map<string, Uint8Array>();
  for (const entry of inflated) {
    const key = entry.filename.replace(/^\.\//, '').toLowerCase();
    if (entries.has(key)) throw new Error(`Invalid ${kind}: duplicate archive entry`);
    entries.set(key, entry.bytes);
  }
  const activeEntry = Array.from(entries.keys()).find(isActiveEntryPath);
  const contentTypes = readBoundedXml(entries, '[Content_Types].xml', limits.maxContentTypesBytes, kind);
  if (activeEntry) throw activeContentError(kind);
  return { entries, contentTypes };
}
