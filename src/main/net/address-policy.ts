import { isIPv4, isIPv6 } from 'node:net';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * Address policy for outbound web-article fetches.
 *
 * This module is the single place that decides whether Interleaf is allowed to
 * talk to an address. It is deliberately pure and synchronous: it takes a URL
 * string or a resolved IP literal and answers yes/no. Nothing here performs
 * DNS or I/O, so the fetcher can call it at every point where the destination
 * could change — the submitted URL, each redirect target, and every address DNS
 * returns — and the whole policy is unit-testable without a network.
 *
 * The rule is allow-list first (scheme, default port, no credentials) and then
 * deny-list on the resolved address, covering loopback, private, link-local,
 * CGNAT, multicast, and the IANA special-purpose reservations. Anything that
 * cannot be parsed into a concrete public address is rejected rather than
 * passed through.
 */

/** Only the default port for each scheme. A nonstandard port is rejected outright. */
const ALLOWED_SCHEME_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

const MAX_HOSTNAME_LENGTH = 253;
const MAX_HOSTNAME_LABEL_LENGTH = 63;

export type ValidatedRequestUrl = {
  /** Normalized absolute URL that is safe to hand to the transport. */
  readonly url: URL;
  /** Lowercased hostname with any IPv6 brackets removed. */
  readonly hostname: string;
  readonly port: number;
  /** True when the hostname is already an IP literal and needs no DNS. */
  readonly isIpLiteral: boolean;
};

function reject(message: string): never {
  throw new InterleafError('security-violation', message);
}

/** IPv4 dotted-quad to four bytes, or `null` when it is not a plain dotted quad. */
function parseIpv4(address: string): readonly number[] | null {
  if (!isIPv4(address)) return null;
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IANA special-purpose and non-global IPv4 space.
 *
 * Everything outside these ranges is treated as public unicast. The list is
 * expressed as explicit prefixes so each entry is readable and testable.
 */
function isBlockedIpv4(bytes: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  switch (a) {
    case 0:
    case 10:
    case 127:
      return true;
    case 100:
      return b >= 64 && b <= 127;
    case 169:
      return b === 254;
    case 172:
      return b >= 16 && b <= 31;
    case 192:
      return (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168;
    case 198:
      return b === 18 || b === 19 || (b === 51 && c === 100);
    case 203:
      return b === 0 && c === 113;
    default:
      return a >= 224;
  }
}

function expandIpv6Groups(address: string): readonly string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  let tail: string[] = [];
  if (halves.length === 2 && halves[1] !== undefined && halves[1] !== '') {
    tail = halves[1].split(':');
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

/** IPv6 text to sixteen bytes, including the trailing dotted-quad form. */
function parseIpv6(address: string): readonly number[] | null {
  if (!isIPv6(address)) return null;
  const scopeless = address.split('%')[0] ?? address;
  let working = scopeless;
  let trailing: readonly number[] = [];
  const lastColon = scopeless.lastIndexOf(':');
  const suffix = scopeless.slice(lastColon + 1);
  if (suffix.includes('.')) {
    const embedded = parseIpv4(suffix);
    if (embedded === null) return null;
    trailing = embedded;
    working = `${scopeless.slice(0, lastColon + 1)}0:0`;
  }
  const groups = expandIpv6Groups(working);
  if (groups === null) return null;
  const wanted = trailing.length > 0 ? 6 : 8;
  const bytes: number[] = [];
  for (let index = 0; index < wanted; index += 1) {
    const raw = groups[index] ?? '0';
    const value = Number.parseInt(raw === '' ? '0' : raw, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return [...bytes, ...trailing];
}

function isZeroPrefix(bytes: readonly number[], end: number): boolean {
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * IPv6 forms that embed or tunnel an IPv4 address are rejected wholesale rather
 * than unwrapped: an attacker choosing the encoding is a strong signal, and
 * refusing the encoding removes a class of parser-disagreement bugs.
 */
function isIpv4DerivedIpv6(bytes: readonly number[]): boolean {
  if (isZeroPrefix(bytes, 10)) return true; // ::/96 compatible and ::ffff:0:0/96 mapped
  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  if (a === 0x00 && b === 0x64 && c === 0xff && d === 0x9b) return true; // 64:ff9b::/96 and 64:ff9b:1::/48
  if (a === 0x20 && b === 0x02) return true; // 2002::/16 6to4
  if (a === 0x20 && b === 0x01 && c === 0x00 && d === 0x00) return true; // 2001::/32 Teredo
  return false;
}

/**
 * Rejects IANA Special-Purpose Address Registry ranges within 2000::/3:
 *
 * - 2001:0000::/23 (RFC 4773 / IANA Special-Purpose parent block).
 *   Spans 2001:0000:: through 2001:01ff:ffff:..., covering Teredo (2001::/32),
 *   PCP Anycast (2001:1::/32), Benchmarking (2001:2::/48), AMT (2001:3::/32),
 *   AS112-v6 (2001:4:112::/48), LISP (2001:5::/32), ORCHID/Drone (2001:10::/28,
 *   2001:20::/28, 2001:30::/28), and all unallocated non-global gaps within the
 *   parent prefix (e.g. 2001:100::1 and 2001:1ff::1). Interleaf conservatively
 *   rejects the entire /23 parent block to ensure no non-global gap can pass.
 * - 2001:0db8::/32 (Documentation, RFC 3849).
 * - 2620:004f:8000::/48 (Direct Delegation AS112 Service, RFC 7535).
 * - 3fff::/20 (Documentation, RFC 9637 - covers 3fff:0000:: through 3fff:0fff:ffff:...).
 */
function isReservedIpv6SpecialPrefix(a: number, b: number, c: number, d: number, e: number): boolean {
  if (a === 0x20 && b === 0x01) {
    if ((c & 0xfe) === 0x00) return true;
    return c === 0x0d && d === 0xb8;
  }
  if (a === 0x26 && b === 0x20 && c === 0x00 && d === 0x4f) {
    return (e & 0x80) === 0x80;
  }
  return a === 0x3f && b === 0xff && (c & 0xf0) === 0x00;
}

function isBlockedIpv6(bytes: readonly number[]): boolean {
  if (isIpv4DerivedIpv6(bytes)) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = bytes;
  if ((a & 0xe0) !== 0x20) return true;
  return isReservedIpv6SpecialPrefix(a, b, c, d, e);
}

/**
 * True when Interleaf must not connect to this address.
 *
 * Unparsable input is blocked, so a malformed or unexpected address from a
 * resolver can never be treated as public by accident.
 */
export function isBlockedAddress(address: string): boolean {
  const trimmed = address.trim();
  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(trimmed);
  if (ipv6 !== null) {
    if (ipv6.every((byte) => byte === 0)) return true; // ::
    if (ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1) return true; // ::1
    return isBlockedIpv6(ipv6);
  }
  return true;
}

/** Rejects a resolved address, naming the destination class rather than the address. */
export function assertAllowedAddress(address: string): void {
  if (isBlockedAddress(address)) {
    reject('That site resolves to a private or reserved network address, so Interleaf did not connect.');
  }
}

function assertHostnameShape(hostname: string): void {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    reject('That web address does not have a valid host name.');
  }
  if (hostname.endsWith('.')) {
    reject('That web address does not have a valid host name.');
  }
  const labels = hostname.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_HOSTNAME_LABEL_LENGTH) {
      reject('That web address does not have a valid host name.');
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      reject('That web address does not have a valid host name.');
    }
  }
  if (labels.length < 2) {
    reject('Enter a full public web address, such as https://example.com/article.');
  }
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    reject('That is not a valid web address.');
  }
}

/**
 * Validates one destination: the submitted URL or a redirect target.
 *
 * Called for every hop, so a redirect cannot escape the policy that the first
 * URL passed. Throws a typed `security-violation` on rejection; the caller maps
 * it to a safe renderer-visible message.
 */
export function assertRequestUrl(raw: string): ValidatedRequestUrl {
  const url = parseUrl(raw);

  const expectedPort = ALLOWED_SCHEME_PORTS[url.protocol];
  if (expectedPort === undefined) {
    reject('Interleaf can only import http and https web pages.');
  }
  if (url.username !== '' || url.password !== '') {
    reject('Interleaf does not fetch web addresses that contain a user name or password.');
  }
  if (url.port !== '' && Number.parseInt(url.port, 10) !== expectedPort) {
    reject('Interleaf only fetches web pages on their standard ports.');
  }

  const hostname = url.hostname.toLowerCase();
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (isIPv4(unbracketed) || isIPv6(unbracketed)) {
    assertAllowedAddress(unbracketed);
    return { url, hostname: unbracketed, port: expectedPort, isIpLiteral: true };
  }

  assertHostnameShape(unbracketed);
  return { url, hostname: unbracketed, port: expectedPort, isIpLiteral: false };
}

/**
 * A URL safe to persist as provenance and show in the library: no credentials,
 * no fragment, and bounded length. The path and query are kept because they
 * identify the article, but they are never interpreted as a local path.
 */
export function toProvenanceUrl(url: URL, maxLength: number): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  copy.username = '';
  copy.password = '';
  const text = copy.toString();
  if (text.length > maxLength) {
    reject('That article address is too long.');
  }
  return text;
}
