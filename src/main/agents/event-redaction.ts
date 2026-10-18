import type { AgentEventDraft } from '@shared/types/agent';
import {
  isPortableArray,
  isPortableRecord,
  parsePortableJson,
  type MutablePortableRecord,
  type MutablePortableValue,
  type PortableRecord,
  type PortablePrimitive,
  type PortableRecordDraft,
  type PortableValue,
} from '@shared/models/portable';
import type { PortableMember } from '@shared/models/portable';
import {
  REDACTED,
  sanitizeSignal,
  toAgentEventDraft,
  toRedactedEvent,
  type AgentEventView,
  type RedactableAgentEvent,
} from './redactable-event';

const MAX_REDACTED_TEXT = 65_536;
const MAX_REDACTED_DEPTH = 6;
const MAX_REDACTED_KEYS = 128;
const MAX_REDACTED_ARRAY = 128;

const SECRET_KEY = /(api[_-]?key|access[_-]?token|auth(?:entication)?|bearer|client[_-]?secret|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|token)/iu;
/** Concrete spellings represented by the assignment grammar below. Keep this
 * list authoritative so matching and trailing/partial ambiguity checks cannot
 * drift into separate hand-maintained alias lists. */
export const SECRET_ASSIGNMENT_NAMES = [
  'api_key', 'api-key', 'apikey',
  'access_token', 'access-token', 'accesstoken',
  'auth', 'authentication', 'authorization',
  'bearer',
  'client_secret', 'client-secret', 'clientsecret',
  'credential', 'credentials',
  'password', 'passwd',
  'private_key', 'private-key', 'privatekey',
  'refresh_token', 'refresh-token', 'refreshtoken',
  'secret', 'token',
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const SECRET_NAMES_PATTERN = SECRET_ASSIGNMENT_NAMES.map(escapeRegex).join('|');
const SECRET_ASSIGNMENT_KEY = new RegExp(
  `(?:\\b(?:${SECRET_NAMES_PATTERN})\\b|"(?:${SECRET_NAMES_PATTERN})"|'(?:${SECRET_NAMES_PATTERN})')\\s*[:=]\\s*`,
  'giu',
);
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
/**
 * Recognize supported credential spellings with their required separators.
 * The old `sk` prefix was too broad: it also matched the ordinary CLI flag
 * `--skip-git-repo-check` because the remainder was treated as token data.
 */
const TOKEN_SHAPES = /\b(?:sk[-_]|rk[-_]|pk[-_]|ghp_|gho_|ghs_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b|\bAKIA[A-Za-z0-9]{8,}\b/gu;
const PRIVATE_KEY_BEGIN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/giu;
const PRIVATE_KEY_END = /-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu;

const MAX_OBJECT_KEY_LENGTH = 256;
const MAX_OBJECT_KEY_BYTES = 256;

function isKeyOverlong(key: string): boolean {
  if (key.length > MAX_OBJECT_KEY_LENGTH) return true;
  return Buffer.byteLength(key, 'utf8') > MAX_OBJECT_KEY_BYTES;
}
export type RedactionValue = {
  readonly value: string;
  readonly kind: 'generic' | 'path';
  /** Default true for explicit secrets. Main-owned ambient environment values
   * can opt out of terminal-prefix quarantine to avoid pinning ordinary text
   * on incidental prefixes such as LANG/TERM. */
  readonly terminalPrefix?: boolean;
};
type RedactionInput = string | RedactionValue;

/**
 * Redacts agent output at the privileged boundary. Sensitive keys and values
 * are redacted before crossing into SQLite or renderer subscriptions, with
 * sensitive keys collision-safely renamed to non-sensitive placeholders.
 * Values supplied by a child environment are matched before common
 * credential shapes, including when a provider uses an unusual key name.
 */
export function redactText(value: string, secretValues: readonly RedactionInput[] = []): string {
  let output = value;
  const normalized = normalizeRedactionValues(secretValues);
  // Replace the most specific values first. A shorter inherited path such as
  // TMPDIR can otherwise consume the prefix of a longer canonical target and
  // leave the target's suffix visible after the first replacement.
  for (const secret of normalized.filter((item) => item.kind === 'path' && item.value.length < 4)) {
    // A one-to-three character path (`/`, `/a`, `C:\\`) has no safe textual
    // boundary in hostile output. Quarantine the bounded event instead of
    // replacing every slash or drive prefix and corrupting unrelated text.
    if (containsPathValue(output, secret.value)) return REDACTED;
  }
  for (const secret of normalized.filter((item) => item.kind === 'path' && item.value.length >= 4).sort((left, right) => right.value.length - left.value.length)) {
    output = redactPathValue(output, secret.value);
  }
  // Explicitly registered generic values are sensitive even when they are
  // short. The caller opted into these values from the child environment, so
  // redact every non-empty length (bounded by ingress/event budgets).
  for (const secret of normalized.filter((item) => item.kind === 'generic').sort((left, right) => right.value.length - left.value.length)) {
    output = replaceRegisteredSecret(output, secret.value);
  }
  output = redactPrivateKeyBlocks(output);
  output = output.replace(BEARER, REDACTED);
  output = redactAssignments(output);
  output = output.replace(JWT, REDACTED).replace(TOKEN_SHAPES, REDACTED);
  return output.length <= MAX_REDACTED_TEXT ? output : `${output.slice(0, MAX_REDACTED_TEXT - REDACTED.length)}${REDACTED}`;
}

/** Replaces a registered value without recursively matching the redaction
 * marker itself. This matters for short values such as `C`, which occurs in
 * `[REDACTED]`; existing markers must remain idempotent. */
function replaceRegisteredSecret(input: string, secret: string): string {
  if (secret.length === 0) return input;
  let output = '';
  let cursor = 0;
  while (cursor < input.length) {
    const markerStart = input.indexOf(REDACTED, cursor);
    const secretStart = input.indexOf(secret, cursor);
    if (secretStart < 0) break;
    if (markerStart >= 0 && markerStart <= secretStart) {
      const markerEnd = markerStart + REDACTED.length;
      output += input.slice(cursor, markerEnd);
      cursor = markerEnd;
      continue;
    }
    output += input.slice(cursor, secretStart);
    output += REDACTED;
    cursor = secretStart + secret.length;
  }
  return output + input.slice(cursor);
}

function findRegisteredSecretRanges(text: string, secret: string): [number, number][] {
  if (secret.length === 0) return [];
  const intervals: [number, number][] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const markerStart = text.indexOf(REDACTED, cursor);
    const secretStart = text.indexOf(secret, cursor);
    if (secretStart < 0) break;
    if (markerStart >= 0 && markerStart <= secretStart) {
      cursor = markerStart + REDACTED.length;
      continue;
    }
    intervals.push([secretStart, secretStart + secret.length]);
    cursor = secretStart + secret.length;
  }
  return intervals;
}

function normalizeRedactionValues(values: readonly RedactionInput[]): readonly RedactionValue[] {
  const normalized = new Map<string, RedactionValue>();
  for (const value of values) {
    const candidate = typeof value === 'string' ? { value, kind: 'generic' as const } : value;
    if (candidate.value.length === 0) continue;
    const existing = normalized.get(candidate.value);
    if (existing === undefined || (existing.kind === 'generic' && candidate.kind === 'path')) normalized.set(candidate.value, candidate);
  }
  return [...normalized.values()];
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function windowsPathPattern(value: string): RegExp {
  let pattern = '';
  for (const character of value) {
    if (character === '\\' || character === '/') pattern += '[\\\\/]';
    else pattern += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(pattern, 'giu');
}

function containsPathValue(input: string, value: string): boolean {
  return isWindowsPath(value) ? windowsPathPattern(value).test(input) : input.includes(value);
}

function redactPathValue(input: string, value: string): string {
  return isWindowsPath(value) ? input.replace(windowsPathPattern(value), REDACTED) : input.split(value).join(REDACTED);
}

function redactPrivateKeyBlocks(input: string): string {
  let output = '';
  let cursor = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let begin: RegExpExecArray | null;
  while ((begin = PRIVATE_KEY_BEGIN.exec(input)) !== null) {
    output += input.slice(cursor, begin.index);
    const boundedBlock = input.slice(begin.index, Math.min(input.length, begin.index + MAX_REDACTED_TEXT));
    PRIVATE_KEY_END.lastIndex = begin[0].length;
    const end = PRIVATE_KEY_END.exec(boundedBlock);
    if (end === null) {
      // If the terminator is absent within the bounded key window, quarantine
      // the rest of this input rather than exposing an unterminated key.
      return `${output}${REDACTED}`;
    }
    output += REDACTED;
    cursor = begin.index + end.index + end[0].length;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
  }
  return `${output}${input.slice(cursor)}`;
}

function redactAssignments(input: string): string {
  let output = '';
  let cursor = 0;
  SECRET_ASSIGNMENT_KEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT_KEY.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    const value = redactAssignmentValue(input, valueStart);
    output += input.slice(cursor, valueStart);
    output += value.replacement;
    cursor = value.end;
    SECRET_ASSIGNMENT_KEY.lastIndex = cursor;
  }
  return `${output}${input.slice(cursor)}`;
}

type AssignmentValueRedaction = { readonly replacement: string; readonly end: number };

/**
 * Redacts one assignment value with a bounded linear scan. Regexes that try
 * to model escaped quotes tend to either stop early (leaking a suffix) or
 * backtrack over hostile output. This parser accepts both shell-style quoted
 * values and bounded unquoted values while preserving the delimiter suffix.
 */
function redactAssignmentValue(input: string, start: number): AssignmentValueRedaction {
  if (input.slice(start).startsWith(REDACTED)) {
    return { replacement: REDACTED, end: start + REDACTED.length };
  }
  const quote = input[start];
  if (quote === '"' || quote === "'") {
    if (input.slice(start + 1).startsWith(`${REDACTED}${quote}`)) {
      return { replacement: `${quote}${REDACTED}${quote}`, end: start + 1 + REDACTED.length + 1 };
    }
    const end = findClosingQuote(input, start + 1, quote, Math.min(input.length, start + 1 + MAX_REDACTED_TEXT));
    if (end !== null) return { replacement: `${quote}${REDACTED}${quote}`, end: end + 1 };
    // An unterminated quoted assignment is hostile by construction. Consume
    // the entire remaining bounded input so a suffix or later line cannot
    // reconstruct a secret fragment. StreamRedactor holds this state across
    // chunks and calls the same bounded parser at finish().
    return { replacement: `${quote}${REDACTED}`, end: input.length };
  }
  let index = start;
  const limit = Math.min(input.length, start + MAX_REDACTED_TEXT);
  while (index < limit) {
    const character = input[index];
    if (character === undefined || /[\s,;&}"']/u.test(character)) break;
    index += 1;
  }
  return { replacement: REDACTED, end: index };
}

function findClosingQuote(input: string, start: number, quote: '"' | "'", limit: number): number | null {
  let escaped = false;
  for (let index = start; index < limit; index += 1) {
    const character = input[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === quote) return index;
  }
  return null;
}

/** Returns the first quoted secret assignment that crosses a candidate line
 * boundary. ProcessRunner uses this to keep multiline credentials in one
 * redaction unit instead of emitting a safe-looking first line. */
export function findQuotedSecretAssignment(input: string, before: number): { readonly start: number; readonly end: number | null } | null {
  SECRET_ASSIGNMENT_KEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT_KEY.exec(input)) !== null) {
    if (match.index >= before) return null;
    const valueStart = match.index + match[0].length;
    const quote = input[valueStart];
    if (quote !== '"' && quote !== "'") continue;
    const end = findClosingQuote(input, valueStart + 1, quote, input.length);
    if (end !== null && end < before) continue;
    return { start: match.index, end };
  }
  return null;
}

/**
 * A bracketed assignment is still an untrusted secret value. Square brackets
 * are deliberately treated as ordinary value characters by
 * `redactAssignmentValue`; this companion check only keeps an unterminated
 * bracketed value buffered when it is split across event/ref boundaries.
 */
function hasUnclosedBracketedSecretAssignment(input: string): boolean {
  SECRET_ASSIGNMENT_KEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT_KEY.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (input[valueStart] !== '[') continue;
    if (!input.slice(valueStart + 1).includes(']')) return true;
  }
  return false;
}

/** JSON-lines parsing happens before redaction. Registered generic secrets
 * therefore also need to match primitive leaves by their canonical JSON
 * spelling (for example `1`, `true`, or `null`), not only string leaves. */
function canonicalRedactablePrimitive(value: PortableValue): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : undefined;
  }
  return undefined;
}

const JSON_PRIMITIVE_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export function canonicalRegisteredPrimitive(value: string): string | undefined {
  if (value !== 'true' && value !== 'false' && value !== 'null' && !JSON_PRIMITIVE_NUMBER.test(value)) return undefined;
  try {
    return canonicalRedactablePrimitive(parsePortableJson(value));
  } catch {
    return undefined;
  }
}
function buildCanonicalPrimitiveSet(secrets: readonly RedactionValue[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const secret of secrets) {
    const canonical = canonicalRegisteredPrimitive(secret.value);
    if (canonical !== undefined) set.add(canonical);
  }
  return set;
}

function redactPrimitiveLeaf(value: PortablePrimitive, canonicalPrimitives: ReadonlySet<string>): PortablePrimitive {
  if (typeof value === 'number' && !Number.isFinite(value)) return REDACTED;
  const canonical = canonicalRedactablePrimitive(value);
  if (canonical !== undefined && canonicalPrimitives.has(canonical)) return REDACTED;
  return value;
}


function redactValue(
  value: PortableValue,
  secretValues: readonly RedactionInput[] = [],
  depth = 0,
  canonicalPrimitives?: ReadonlySet<string>,
): PortableValue {
  if (depth > MAX_REDACTED_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactText(value, secretValues);
  const normalized = normalizeRedactionValues(secretValues);
  const primitives = canonicalPrimitives ?? buildCanonicalPrimitiveSet(normalized);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return redactPrimitiveLeaf(value, primitives);
  }
  if (isPortableArray(value)) return value.slice(0, MAX_REDACTED_ARRAY).map((entry) => redactValue(entry, normalized, depth + 1, primitives));
  if (typeof value !== 'object') return REDACTED;
  const output: PortableRecordDraft = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_REDACTED_KEYS)) {
    // Secret-looking field names identify sensitive values, but are not
    // themselves secret values. Only redact a key when a registered value is
    // actually present in the key (including short values such as `1`).
    const redactedKey = redactText(key, normalized);
    const boundedKey = redactedKey.length <= MAX_OBJECT_KEY_LENGTH ? redactedKey : REDACTED;
    let outputKey = boundedKey;
    let disambiguator = 1;
    while (Object.prototype.hasOwnProperty.call(output, outputKey)) {
      const suffix = `_${String(disambiguator)}`;
      outputKey = `${boundedKey.slice(0, Math.max(0, MAX_OBJECT_KEY_LENGTH - suffix.length))}${suffix}`;
      disambiguator += 1;
    }
    output[outputKey] = SECRET_KEY.test(key) ? REDACTED : redactValue(entry, normalized, depth + 1, primitives);
  }
  return output;
}

export function redactRecord(value: PortableRecord, secretValues: readonly RedactionInput[] = []): PortableRecord {
  const normalized = normalizeRedactionValues(secretValues);
  const primitives = buildCanonicalPrimitiveSet(normalized);
  const redacted = redactValue(value, normalized, 0, primitives);
  return isPortableRecord(redacted) ? redacted : { value: REDACTED };
}

const MAX_BUFFERED_EVENTS = 500;
const MAX_BUFFERED_CHARS = 100_000;

function mergeIntervals(intervals: readonly (readonly [number, number])[]): [number, number][] {
  if (intervals.length <= 1) return intervals.map((i) => [i[0], i[1]]);
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: [number, number][] = [];
  const first = sorted[0];
  if (first === undefined) return result;
  let current: [number, number] = [first[0], first[1]];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    if (next === undefined) continue;
    if (next[0] <= current[1]) {
      current = [current[0], Math.max(current[1], next[1])];
    } else {
      result.push(current);
      current = [next[0], next[1]];
    }
  }
  result.push(current);
  return result;
}

export function findRedactionRangesInText(
  text: string,
  secretValues: readonly RedactionInput[] = [],
): [number, number][] {
  const intervals: [number, number][] = [];
  const normalized = normalizeRedactionValues(secretValues);

  for (const secret of normalized.filter((item) => item.kind === 'path' && item.value.length >= 4)) {
    if (isWindowsPath(secret.value)) {
      const pattern = windowsPathPattern(secret.value);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        intervals.push([match.index, match.index + match[0].length]);
      }
    } else {
      let idx = text.indexOf(secret.value);
      while (idx >= 0) {
        intervals.push([idx, idx + secret.value.length]);
        idx = text.indexOf(secret.value, idx + 1);
      }
    }
  }

  for (const secret of normalized.filter((item) => item.kind === 'path' && item.value.length < 4)) {
    if (isWindowsPath(secret.value)) {
      const pattern = windowsPathPattern(secret.value);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        intervals.push([match.index, match.index + match[0].length]);
      }
    } else {
      let idx = text.indexOf(secret.value);
      while (idx >= 0) {
        intervals.push([idx, idx + secret.value.length]);
        idx = text.indexOf(secret.value, idx + 1);
      }
    }
  }

  for (const secret of normalized.filter((item) => item.kind === 'generic')) {
    intervals.push(...findRegisteredSecretRanges(text, secret.value));
  }

  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let beginMatch: RegExpExecArray | null;
  while ((beginMatch = PRIVATE_KEY_BEGIN.exec(text)) !== null) {
    const beginIdx = beginMatch.index;
    PRIVATE_KEY_END.lastIndex = beginIdx + beginMatch[0].length;
    const endMatch = PRIVATE_KEY_END.exec(text);
    if (endMatch === null) {
      intervals.push([beginIdx, text.length]);
      break;
    } else {
      const endIdx = endMatch.index + endMatch[0].length;
      intervals.push([beginIdx, endIdx]);
      PRIVATE_KEY_BEGIN.lastIndex = endIdx;
    }
  }

  const regexList = [BEARER, JWT, TOKEN_SHAPES];
  for (const regex of regexList) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      intervals.push([match.index, match.index + match[0].length]);
    }
  }

  SECRET_ASSIGNMENT_KEY.lastIndex = 0;
  let assignMatch: RegExpExecArray | null;
  while ((assignMatch = SECRET_ASSIGNMENT_KEY.exec(text)) !== null) {
    const valueStart = assignMatch.index + assignMatch[0].length;
    const value = redactAssignmentValue(text, valueStart);
    intervals.push([valueStart, value.end]);
    SECRET_ASSIGNMENT_KEY.lastIndex = value.end;
  }

  return mergeIntervals(intervals);
}


type IngressBudget = {
  currentChars: number;
  readonly maxChars: number;
  overflowed: boolean;
};
function isBudgetOverflowed(budget: IngressBudget): boolean {
  return budget.overflowed;
}

function sanitizeValueOnIngress(
  val: PortableMember,
  depth: number,
  seen: WeakSet<object>,
  budget: IngressBudget,
  canonicalPrimitives: ReadonlySet<string>,
): MutablePortableValue {
  if (isBudgetOverflowed(budget)) {
    return REDACTED;
  }
  if (val === null || typeof val === 'number' || typeof val === 'boolean') {
    const sanitized = redactPrimitiveLeaf(val, canonicalPrimitives);
    if (typeof sanitized === 'string') {
      budget.currentChars += sanitized.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    }
    return sanitized;
  }
  if (typeof val === 'string') {
    if (val.length > MAX_REDACTED_TEXT) {
      budget.currentChars += REDACTED.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
      return REDACTED;
    }
    budget.currentChars += val.length;
    if (budget.currentChars > budget.maxChars) {
      budget.overflowed = true;
      return REDACTED;
    }
    return val;
  }
  if (depth > MAX_REDACTED_DEPTH) {
    budget.currentChars += REDACTED.length;
    if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    return REDACTED;
  }
  if (typeof val !== 'object') {
    budget.currentChars += REDACTED.length;
    if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    return REDACTED;
  }
  if (seen.has(val)) {
    budget.currentChars += REDACTED.length;
    if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    return REDACTED;
  }
  seen.add(val);

  if (isPortableArray(val)) {
    const result: MutablePortableValue[] = [];
    const len = Math.min(val.length, MAX_REDACTED_ARRAY);
    for (let i = 0; i < len; i += 1) {
      if (isBudgetOverflowed(budget)) {
        result.push(REDACTED);
        break;
      }
      result.push(sanitizeValueOnIngress(val[i], depth + 1, seen, budget, canonicalPrimitives));
    }
    return result;
  }
  const result: MutablePortableRecord = {};
  const record: PortableRecord = val;
  let sanitizedKeyIndex = 0;
  let keyCount = 0;
  for (const rawKey in record) {
    if (!Object.prototype.hasOwnProperty.call(record, rawKey)) continue;
    if (keyCount >= MAX_REDACTED_KEYS) break;
    keyCount += 1;
    if (isBudgetOverflowed(budget)) break;

    let key = rawKey;
    if (isKeyOverlong(key)) {
      let candidate = `__redacted_key_${String(sanitizedKeyIndex)}`;
      while (
        Object.prototype.hasOwnProperty.call(record, candidate) ||
        Object.prototype.hasOwnProperty.call(result, candidate)
      ) {
        sanitizedKeyIndex += 1;
        candidate = `__redacted_key_${String(sanitizedKeyIndex)}`;
      }
      sanitizedKeyIndex += 1;
      key = candidate;
      budget.currentChars += REDACTED.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    } else {
      budget.currentChars += key.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    }
    const propVal: PortableMember = record[rawKey];
    if (SECRET_KEY.test(rawKey)) {
      result[key] = REDACTED;
      budget.currentChars += REDACTED.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    } else {
      result[key] = sanitizeValueOnIngress(propVal, depth + 1, seen, budget, canonicalPrimitives);
    }
  }
  return result;
}

function sanitizeEventOnIngress(
  event: AgentEventView,
  initialBufferedChars: number,
  canonicalPrimitives: ReadonlySet<string>,
): { readonly sanitized: RedactableAgentEvent; readonly textLength: number; readonly overflowed: boolean } {
  const budget: IngressBudget = {
    currentChars: initialBufferedChars,
    maxChars: MAX_BUFFERED_CHARS,
    overflowed: false,
  };
  const seen = new WeakSet<object>();

  const result: MutablePortableRecord = {
    sessionId: event.sessionId,
    type: event.type,
    timestamp: event.timestamp,
  };

  if (event.stream !== undefined) result.stream = event.stream;
  if (event.exitCode !== undefined) result.exitCode = event.exitCode;
  if (event.signal !== undefined) result.signal = sanitizeSignal(event.signal);
  if (typeof event.text === 'string') {
    if (event.text.length > MAX_REDACTED_TEXT) {
      result.text = REDACTED;
      budget.currentChars += REDACTED.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    } else {
      result.text = event.text;
      budget.currentChars += event.text.length;
      if (budget.currentChars > budget.maxChars) budget.overflowed = true;
    }
  }

  if (event.data !== undefined) {
    result.data = sanitizeValueOnIngress(event.data, 0, seen, budget, canonicalPrimitives);
  }

  if (event.error !== undefined) {
    result.error = sanitizeValueOnIngress(event.error, 0, seen, budget, canonicalPrimitives);
  }

  const textLength = budget.currentChars - initialBufferedChars;

  return {
    sanitized: toRedactedEvent(event, result),
    textLength,
    overflowed: budget.overflowed,
  };
}

type StringRef = {
  get(): string;
  set(value: string): void;
  startOffset: number;
  endOffset: number;
};

type ObjectPropertyRef = {
  record: MutablePortableRecord;
  originalKey: string;
  getKey: () => string;
  setKey: (k: string) => void;
};
function applyRedactionRangesToRefs(
  refs: StringRef[],
  secretValues: readonly RedactionValue[],
): void {
  if (refs.length === 0) return;
  let aggregatedText = '';
  for (const ref of refs) {
    ref.startOffset = aggregatedText.length;
    aggregatedText += ref.get();
    ref.endOffset = aggregatedText.length;
  }

  const globalRanges = findRedactionRangesInText(aggregatedText, secretValues);

  for (const ref of refs) {
    const raw = ref.get();
    if (raw.length === 0) continue;

    const localRanges = findRedactionRangesInText(raw, secretValues);
    const overlapping: [number, number][] = [...localRanges];

    const refStart = ref.startOffset;
    const refEnd = ref.endOffset;
    const len = refEnd - refStart;

    for (const [rStart, rEnd] of globalRanges) {
      if (rEnd <= refStart || rStart >= refEnd) continue;
      const localStart = Math.max(0, rStart - refStart);
      const localEnd = Math.min(len, rEnd - refStart);
      if (localStart < localEnd) {
        overlapping.push([localStart, localEnd]);
      }
    }

    if (overlapping.length > 0) {
      const mergedLocal = mergeIntervals(overlapping);
      // A range replacement is normally a fixed ten-character marker. A
      // dense short-secret match can therefore expand one bounded source
      // string by orders of magnitude (for example, alternating `qX` over a
      // near-limit text value). Decide from lengths before constructing the
      // replacement so redaction itself cannot become the allocation DoS.
      const redactedSourceLength = mergedLocal.reduce(
        (total, [start, end]) => total + (end - start),
        0,
      );
      const replacementLength = raw.length - redactedSourceLength + REDACTED.length * mergedLocal.length;
      const exceedsSourceEnvelope = mergedLocal.length > 1 && replacementLength > raw.length * 2;
      const exceedsRedactedBound = replacementLength > MAX_REDACTED_TEXT;
      if (exceedsSourceEnvelope || exceedsRedactedBound) {
        // value refs, key refs, event text, nested data, and serialized error
        // strings alike; key flushing below still handles any resulting key
        // collision safely.
        ref.set(REDACTED);
        continue;
      }
      let newText = '';
      let cursor = 0;
      for (const [lStart, lEnd] of mergedLocal) {
        if (lStart > cursor) {
          const piece = raw.slice(cursor, lStart);
          newText += piece;
        }
        newText += REDACTED;
        cursor = lEnd;
      }
      if (cursor < raw.length) {
        const piece = raw.slice(cursor);
        newText += piece;
      }
      ref.set(newText);
    }
  }
}

function extractRedactionStreams(
  events: RedactableAgentEvent[],
  canonicalPrimitives?: ReadonlySet<string>,
): {
  readonly valueRefs: StringRef[];
  readonly keyRefs: StringRef[];
  readonly unifiedRefs: StringRef[];
  readonly flush: () => void;
} {
  const valueRefs: StringRef[] = [];
  const keyRefs: StringRef[] = [];
  const unifiedRefs: StringRef[] = [];
  const propertyRefs: ObjectPropertyRef[] = [];
  const seen = new WeakSet<object>();

  function traverseObject(record: MutablePortableRecord, depth: number): void {
    if (depth > MAX_REDACTED_DEPTH || seen.has(record)) return;
    seen.add(record);
    for (const k in record) {
      if (!Object.prototype.hasOwnProperty.call(record, k)) continue;
      let currentKey = k;
      const keyRef: StringRef = {
        get: () => currentKey,
        set: (next) => { currentKey = next; },
        startOffset: 0,
        endOffset: 0,
      };
      keyRefs.push(keyRef);
      unifiedRefs.push(keyRef);
      propertyRefs.push({
        record,
        originalKey: k,
        getKey: () => currentKey,
        setKey: (next) => { currentKey = next; },
      });
      if (SECRET_KEY.test(k)) {
        record[k] = REDACTED;
        let currentVal = REDACTED;
        const valRef: StringRef = {
          get: () => currentVal,
          set: (next) => {
            currentVal = next;
            record[k] = next;
          },
          startOffset: 0,
          endOffset: 0,
        };
        valueRefs.push(valRef);
        unifiedRefs.push(valRef);
        continue;
      }
      const val = record[k];
      if (typeof val === 'string') {
        let currentVal = val;
        const valRef: StringRef = {
          get: () => currentVal,
          set: (next) => {
            currentVal = next;
            record[k] = next;
          },
          startOffset: 0,
          endOffset: 0,
        };
        valueRefs.push(valRef);
        unifiedRefs.push(valRef);
      } else if (Array.isArray(val)) {
        traverseArray(val, depth + 1);
      } else if (val !== null && typeof val === 'object') {
        traverseObject(val, depth + 1);
      } else if (canonicalPrimitives !== undefined && (val === null || typeof val === 'number' || typeof val === 'boolean')) {
        record[k] = redactPrimitiveLeaf(val, canonicalPrimitives);
      }
    }
  }

  function traverseArray(arr: MutablePortableValue[], depth: number): void {
    if (depth > MAX_REDACTED_DEPTH || seen.has(arr)) return;
    seen.add(arr);
    for (let i = 0; i < arr.length; i += 1) {
      const item = arr[i];
      if (typeof item === 'string') {
        let currentVal = item;
        const valRef: StringRef = {
          get: () => currentVal,
          set: (next) => {
            currentVal = next;
            arr[i] = next;
          },
          startOffset: 0,
          endOffset: 0,
        };
        valueRefs.push(valRef);
        unifiedRefs.push(valRef);
      } else if (Array.isArray(item)) {
        traverseArray(item, depth + 1);
      } else if (item !== null && typeof item === 'object') {
        traverseObject(item, depth + 1);
      } else if (canonicalPrimitives !== undefined && (item === null || typeof item === 'number' || typeof item === 'boolean')) {
        arr[i] = redactPrimitiveLeaf(item, canonicalPrimitives);
      }
    }
  }

  for (const event of events) {
    if (typeof event.text === 'string') {
      const textRef: StringRef = {
        get: () => event.text ?? '',
        set: (next) => { event.text = next; },
        startOffset: 0,
        endOffset: 0,
      };
      valueRefs.push(textRef);
      unifiedRefs.push(textRef);
    }
    if (event.data !== undefined) {
      traverseObject(event.data, 1);
    }
    if (event.error !== undefined) {
      traverseObject(event.error, 1);
    }
  }

  const flush = (): void => {
    for (const prop of propertyRefs) {
      const newKey = prop.getKey();
      const oldKey = prop.originalKey;
      if (newKey !== oldKey) {
        const propVal = prop.record[oldKey];
        // An earlier rename already moved this member; there is nothing left
        // under the old key to carry over.
        if (propVal === undefined) continue;
        Reflect.deleteProperty(prop.record, oldKey);
        let targetKey = newKey;
        let disambiguator = 1;
        while (Object.prototype.hasOwnProperty.call(prop.record, targetKey)) {
          targetKey = `${newKey}_${String(disambiguator)}`;
          disambiguator += 1;
        }
        prop.record[targetKey] = propVal;
      }
    }
  };

  return { valueRefs, keyRefs, unifiedRefs, flush };
}

function isWithinSerializedPayloadBound(value: PortableValue): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= MAX_REDACTED_TEXT;
  } catch {
    return false;
  }
}

function enforceRedactedEventPayloadBounds(
  events: RedactableAgentEvent[],
): RedactableAgentEvent[] {
  return events.map((event) => {
    const textOverflowed = typeof event.text === 'string' && event.text.length > MAX_REDACTED_TEXT;
    const dataOverflowed = event.data !== undefined && !isWithinSerializedPayloadBound(event.data);
    const errorOverflowed = event.error !== undefined && !isWithinSerializedPayloadBound(event.error);
    return textOverflowed || dataOverflowed || errorOverflowed ? quarantineEventLeaves(event) : event;
  });
}

function estimateSanitizedEventTextSize(event: AgentEventView): number {
  let size = 0;
  if (typeof event.text === 'string') size += event.text.length;
  if (event.data !== undefined) size += estimateSanitizedValueSize(event.data);
  if (event.error !== undefined) size += estimateSanitizedValueSize(event.error);
  return size;
}

function estimateSanitizedValueSize(val: PortableMember): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'string') return val.length;
  if (isPortableArray(val)) {
    let size = 0;
    for (const item of val) size += estimateSanitizedValueSize(item);
    return size;
  }
  if (typeof val === 'object') {
    let size = 0;
    for (const [k, v] of Object.entries(val)) {
      size += k.length + estimateSanitizedValueSize(v);
    }
    return size;
  }
  return 0;
}

function isPayloadFreeControlEvent(event: AgentEventView): boolean {
  return (
    (event.text === undefined || event.text.length === 0) &&
    event.data === undefined &&
    event.error === undefined
  );
}

function quarantineEventLeaves(event: AgentEventView): RedactableAgentEvent {
  const cloned: MutablePortableRecord = {
    sessionId: event.sessionId,
    type: event.type,
    timestamp: event.timestamp,
  };
  if (event.stream !== undefined) cloned.stream = event.stream;
  if (event.exitCode !== undefined) cloned.exitCode = event.exitCode;
  if (event.signal !== undefined) cloned.signal = sanitizeSignal(event.signal);
  if (typeof event.text === 'string') {
    cloned.text = REDACTED;
  }
  if (event.data !== undefined) {
    cloned.data = { redacted: true };
  }
  if (event.error !== undefined) {
    cloned.error = {
      __interleafError: true,
      code: 'internal',
      message: REDACTED,
    };
  }
  return toRedactedEvent(event, cloned);
}

export function hasAmbiguousSecretSuffix(
  text: string,
  secretValues: readonly RedactionValue[] = [],
  includeShortKnownPrefixes = false,
): boolean {
  if (text.length === 0) return false;

  const unclosed = findQuotedSecretAssignment(text, text.length);
  if (unclosed !== null && unclosed.end === null) return true;
  if (hasUnclosedBracketedSecretAssignment(text)) return true;

  const lower = text.toLowerCase();
  // Private key header prefix (min 4 chars)
  const privateKeyStart = '-----begin';
  for (let k = 4; k <= privateKeyStart.length; k += 1) {
      if (lower.endsWith(privateKeyStart.slice(0, k))) return true;
  }

  // Token shape prefixes (min 3 or 4 chars)
  const tokenPrefixes = [
    { prefix: 'bearer ', min: 4 },
    { prefix: 'eyj', min: 3 },
    { prefix: 'sk-', min: 3 },
    { prefix: 'sk_', min: 3 },
    { prefix: 'rk-', min: 3 },
    { prefix: 'rk_', min: 3 },
    { prefix: 'pk-', min: 3 },
    { prefix: 'pk_', min: 3 },
    { prefix: 'ghp_', min: 3 },
    { prefix: 'gho_', min: 3 },
    { prefix: 'ghs_', min: 3 },
    { prefix: 'github_pat_', min: 3 },
    { prefix: 'xoxa-', min: 3 },
    { prefix: 'xoxb-', min: 3 },
    { prefix: 'xoxp-', min: 3 },
    { prefix: 'xoxr-', min: 3 },
    { prefix: 'xoxs-', min: 3 },
    { prefix: 'glpat-', min: 4 },
    { prefix: 'key-', min: 3 },
    { prefix: 'token-', min: 4 },
    { prefix: 'token_', min: 4 },
    { prefix: 'token=', min: 4 },
    { prefix: 'token:', min: 4 },
    { prefix: 'akia', min: 4 },
    { prefix: 'asia', min: 4 },
    { prefix: 'aiza', min: 4 },
  ];
  for (const item of tokenPrefixes) {
    const minLen = Math.min(item.min, item.prefix.length);
    const maxLen = Math.min(item.prefix.length, lower.length);
    for (let k = minLen; k <= maxLen; k += 1) {
      if (!lower.endsWith(item.prefix.slice(0, k))) continue;
      const start = lower.length - k;
      const previous = lower[start - 1];
      if (previous !== undefined && /[\p{L}\p{N}_]/u.test(previous)) continue;
      return true;
    }
  }

  // A complete assignment prefix, including optional whitespace around its
  // delimiter, is recognized by the authoritative grammar itself.
  SECRET_ASSIGNMENT_KEY.lastIndex = 0;
  let assignmentMatch: RegExpExecArray | null;
  while ((assignmentMatch = SECRET_ASSIGNMENT_KEY.exec(text)) !== null) {
    if (assignmentMatch.index + assignmentMatch[0].length === text.length) return true;
  }

  // Cover a key name split before its delimiter without treating a suffix of
  // an ordinary word such as `initok` as the partial alias `tok`. A partial
  // alias is only plausible at the start of the stream or after a non-word
  // boundary; the next event then supplies the remaining alias/delimiter.
  // Require two characters so ordinary one-character sparse values do not
  // become permanently ambiguous merely because they start an alias. Full
  // assignment prefixes (including `authorization=` and `passwd=`) remain
  // guarded by the authoritative grammar above.
    const assignmentNameTail = lower.trimEnd();
    for (const name of SECRET_ASSIGNMENT_NAMES) {
      const doubleQuoted = `"${name}"`;
      const singleQuoted = `'${name}'`;
      if (assignmentNameTail.endsWith(doubleQuoted) || assignmentNameTail.endsWith(singleQuoted)) {
        return true;
      }
      const maxLen = Math.min(name.length, assignmentNameTail.length);
      for (let length = 2; length <= maxLen; length += 1) {
        const prefix = name.slice(0, length);
        if (!assignmentNameTail.endsWith(prefix)) continue;
        const start = assignmentNameTail.length - length;
        const previous = assignmentNameTail[start - 1];
        if (previous === undefined || !/[\p{L}\p{N}_]/u.test(previous)) return true;
      }
    }

  // Check known normalized secrets, including one- and two-character
  // prefixes. The bounded pending-event lookbehind ensures these checks do
  // not pin a common one-character value indefinitely.
  for (const secret of secretValues) {
    const val = secret.value.toLowerCase();
    if (val.length < 2) continue;
    const minLen = includeShortKnownPrefixes ? 1 : val.length >= 4 ? 3 : 2;
    const maxPrefixLen = Math.min(val.length - 1, lower.length);
    for (let k = minLen; k <= maxPrefixLen; k += 1) {
      if (lower.endsWith(val.slice(0, k))) return true;
    }
  }

  return false;
}

function getBoundedStreamTail(refs: readonly StringRef[], maxTailChars: number): string {
  if (refs.length === 0) return '';
  const limit = Math.min(MAX_BUFFERED_CHARS, Math.max(256, maxTailChars));
  let tail = '';
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i];
    if (ref === undefined) continue;
    tail = ref.get() + tail;
    if (tail.length >= limit) {
      return tail.slice(tail.length - limit);
    }
  }
  return tail;
}

/**
 * Checks a bounded pending suffix as one logical stream. A single event is
 * not sufficient evidence at a boundary: a path or inherited environment
 * secret may begin with `/`, `a`, or another common one-character fragment
 * and continue in the next event. Keeping the suffix together lets the
 * redactor either find the complete secret now or retain it for the next
 * boundary without exposing the first fragment.
 */
function isEventBatchAmbiguous(
  events: readonly RedactableAgentEvent[],
  secretValues: readonly RedactionValue[],
  maxTailChars?: number,
): boolean {
  if (events.length === 0 || events.every(isPayloadFreeControlEvent)) return false;

  const { valueRefs, keyRefs, unifiedRefs } = extractRedactionStreams([...events]);
  if (valueRefs.length === 0 && keyRefs.length === 0) return false;

  const lengths = secretValues.filter((s) => s.value.length > 0).map((s) => s.value.length);
  const effectiveTailLength = maxTailChars !== undefined
    ? Math.min(MAX_BUFFERED_CHARS, Math.max(256, maxTailChars))
    : Math.min(MAX_BUFFERED_CHARS, Math.max(256, ...lengths));

  const valuesTail = getBoundedStreamTail(valueRefs, effectiveTailLength);
  const lastValueRef = valueRefs.at(-1);
  const valueShortPrefix = lastValueRef !== undefined && lastValueRef.get().length <= 2;
  if (valuesTail.length > 0 && hasAmbiguousSecretSuffix(valuesTail, secretValues, valueShortPrefix)) return true;

  const keysTail = getBoundedStreamTail(keyRefs, effectiveTailLength);
  const lastKeyRef = keyRefs.at(-1);
  const keyShortPrefix = lastKeyRef !== undefined && lastKeyRef.get().length <= 2;
  if (keysTail.length > 0 && hasAmbiguousSecretSuffix(keysTail, secretValues, keyShortPrefix)) return true;

  const unifiedTail = getBoundedStreamTail(unifiedRefs, effectiveTailLength);
  const lastUnifiedRef = unifiedRefs.at(-1);
  const unifiedShortPrefix = lastUnifiedRef !== undefined && lastUnifiedRef.get().length <= 2;
  if (unifiedTail.length > 0 && hasAmbiguousSecretSuffix(unifiedTail, secretValues, unifiedShortPrefix)) return true;

  return false;
}

function hasUnresolvedTerminalSecretPrefix(
  events: readonly RedactableAgentEvent[],
  secretValues: readonly RedactionValue[],
  maxTailChars: number,
): boolean {
  if (events.length === 0 || events.every(isPayloadFreeControlEvent)) return false;
  const { valueRefs, keyRefs, unifiedRefs } = extractRedactionStreams([...events]);
  if (valueRefs.length === 0 && keyRefs.length === 0) return false;
  const hasPrefix = (refs: readonly StringRef[]): boolean => {
    const tail = getBoundedStreamTail(refs, maxTailChars);
    const terminalSecrets = secretValues.filter((secret) => {
      if (secret.terminalPrefix === false) return false;
      return canonicalRegisteredPrimitive(secret.value) === undefined;
    });
    const ambiguous = tail.length > 0 && hasAmbiguousSecretSuffix(tail, terminalSecrets, true);
    return ambiguous;
  };
  return hasPrefix(valueRefs) || hasPrefix(keyRefs) || hasPrefix(unifiedRefs);
}

export class EventRedactor {
  private readonly pendingEvents: RedactableAgentEvent[] = [];
  private totalBufferedEvents = 0;
  private totalBufferedChars = 0;
  private quarantined = false;
  private readonly normalizedSecrets: readonly RedactionValue[];
  private readonly canonicalPrimitives: ReadonlySet<string>;
  private readonly maxSecretLength: number;

  constructor(secretValues: readonly RedactionInput[] = []) {
    this.normalizedSecrets = normalizeRedactionValues(secretValues);
    this.canonicalPrimitives = buildCanonicalPrimitiveSet(this.normalizedSecrets);
    const lengths = this.normalizedSecrets
      .filter((s) => s.value.length > 0)
      .map((s) => s.value.length);
    this.maxSecretLength = Math.min(MAX_BUFFERED_CHARS, Math.max(256, ...lengths));
  }

  /** Current pending retained event count for diagnostics and bounding assertions. */
  get pendingCount(): number {
    return this.pendingEvents.length;
  }

  /** Current pending retained character count for diagnostics and bounding assertions. */
  get pendingChars(): number {
    return this.totalBufferedChars;
  }

  /** Whether the redactor has transitioned to fail-closed quarantine. */
  get isQuarantined(): boolean {
    return this.quarantined;
  }

  /** Pushes an incoming event, returning safe drainable events in exact arrival order. */
  push(event: AgentEventDraft): readonly AgentEventDraft[] { return this.ingest(event).map(toAgentEventDraft); }

  private ingest(event: AgentEventView): readonly RedactableAgentEvent[] {
    const { sanitized, textLength, overflowed } = sanitizeEventOnIngress(event, this.totalBufferedChars, this.canonicalPrimitives);

    if (this.quarantined) {
      const quarantinedEvent = quarantineEventLeaves(sanitized);
      return [quarantinedEvent];
    }

    this.totalBufferedEvents += 1;
    this.totalBufferedChars += textLength;

    if (
      overflowed ||
      this.totalBufferedEvents > MAX_BUFFERED_EVENTS ||
      this.totalBufferedChars > MAX_BUFFERED_CHARS
    ) {
      this.quarantined = true;
      const allEvents = [...this.pendingEvents, sanitized];
      this.pendingEvents.length = 0;
      this.totalBufferedEvents = 0;
      this.totalBufferedChars = 0;
      return allEvents.map((e) => quarantineEventLeaves(e));
    }
    // Immediate drain only for strictly payload-free control events with no pending ambiguity
    if (this.pendingEvents.length === 0 && sanitized.type === 'started' && isPayloadFreeControlEvent(sanitized)) {
      this.totalBufferedEvents = 0;
      this.totalBufferedChars = 0;
      return [sanitized];
    }

    // Immediate drain for safe newline stdout/stderr when no prior events are buffered
    if (
      this.pendingEvents.length === 0 &&
      (sanitized.type === 'stdout' || sanitized.type === 'stderr') &&
      typeof sanitized.text === 'string' &&
      sanitized.text.endsWith('\n') &&
      !hasAmbiguousSecretSuffix(sanitized.text, this.normalizedSecrets, true) &&
      sanitized.data === undefined &&
      sanitized.error === undefined
    ) {
      this.totalBufferedEvents = 0;
      this.totalBufferedChars = 0;
      const [redacted] = this.redactEventBatch([sanitized]);
      return redacted !== undefined ? [redacted] : [];
    }
    this.pendingEvents.push(sanitized);

    if (sanitized.type === 'ended' || sanitized.type === 'cancelled') {
      return this.drainAll();
    }

    return this.drainSafePrefix();
  }

  /** Drains all remaining events in arrival order (called on finish / terminal state). */
  finish(): readonly AgentEventDraft[] {
    return this.drainAll().map(toAgentEventDraft);
  }

  private drainAll(): RedactableAgentEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const eventsToDrain = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.totalBufferedEvents = 0;
    this.totalBufferedChars = 0;

    if (this.quarantined) {
      return eventsToDrain.map((e) => quarantineEventLeaves(e));
    }

    // Finish is terminal: no later event can disambiguate a trailing
    // registered path/environment prefix. Keep the whole bounded terminal
    // unit fail-closed instead of persisting the unresolved prefix.
    if (hasUnresolvedTerminalSecretPrefix(eventsToDrain, this.normalizedSecrets, this.maxSecretLength)) {
      return eventsToDrain.map((e) => quarantineEventLeaves(e));
    }

    return this.redactEventBatch(eventsToDrain);
  }

  private drainSafePrefix(): RedactableAgentEvent[] {
    // Retain one newest payload event as a bounded lookbehind. Evaluate each
    // candidate against the complete suffix currently retained, rather than
    // evaluating events independently. This closes splits such as `/` + the
    // remainder of a canonical path and `authorization=` + its value, while
    // preserving FIFO and allowing the prior safe sparse event to stream once
    // a later payload provides the lookbehind.
    const newestPayloadIndex = this.pendingEvents.findLastIndex((event) => !isPayloadFreeControlEvent(event));
    if (newestPayloadIndex < 0) {
      // Payload-free controls carry no text that can join with a future event.
      // This is primarily defensive: started controls use the immediate path,
      // and terminal controls drain through drainAll().
      return this.drainAll();
    }
    if (this.pendingEvents.length === 1) {
      // Even a currently safe payload must wait for one later payload event
      // (or terminal finish). Without this unconditional lag, a one-character
      // built-in prefix such as `s` could be persisted before `k-...` arrives.
      return [];
    }

    let safePrefixCount = 0;
    // Do not scan through the newest payload event. Payload-free controls
    // after it remain ordered behind it and are therefore retained as well.
    for (let index = 0; index < newestPayloadIndex; index += 1) {
      const candidate = this.pendingEvents[index];
      if (candidate === undefined) continue;
      // Size is not evidence of ambiguity. Ingress and aggregate tail bounds
      // already cap memory, while redactEventBatch collapses dense matches
      // before constructing expanded replacements.
      // Once an event's own trailing payload is ambiguous, retain it until
      // the terminal drain even if the currently buffered suffix completes a
      // known secret. This keeps the first fragment out of subscriptions and
      // SQLite throughout the handoff and preserves exact FIFO release.
      if (isEventBatchAmbiguous(this.pendingEvents.slice(index, index + 1), this.normalizedSecrets, this.maxSecretLength)) {
        break;
      }
      if (isEventBatchAmbiguous(this.pendingEvents.slice(index), this.normalizedSecrets, this.maxSecretLength)) {
        break;
      }
      safePrefixCount += 1;
    }
    if (safePrefixCount === 0) return [];

    const redactedBatch = this.redactEventBatch(this.pendingEvents);
    const safePrefix = redactedBatch.slice(0, safePrefixCount);
    this.pendingEvents.splice(0, safePrefixCount);

    this.totalBufferedEvents = this.pendingEvents.length;
    let remChars = 0;
    for (const e of this.pendingEvents) {
      remChars += estimateSanitizedEventTextSize(e);
    }
    this.totalBufferedChars = remChars;

    return safePrefix;
  }

  private redactEventBatch(events: RedactableAgentEvent[]): RedactableAgentEvent[] {
    const { valueRefs, keyRefs, unifiedRefs, flush } = extractRedactionStreams(events, this.canonicalPrimitives);
    if (valueRefs.length === 0 && keyRefs.length === 0) return enforceRedactedEventPayloadBounds(events);

    applyRedactionRangesToRefs(valueRefs, this.normalizedSecrets);
    applyRedactionRangesToRefs(keyRefs, this.normalizedSecrets);
    applyRedactionRangesToRefs(unifiedRefs, this.normalizedSecrets);

    flush();

    return enforceRedactedEventPayloadBounds(events);
  }
}

export function redactNonStreamEvents(events: readonly AgentEventDraft[], secretValues: readonly RedactionInput[] = []): AgentEventDraft[] {
  const redactor = new EventRedactor(secretValues);
  const drained: AgentEventDraft[] = [];
  for (const event of events) {
    drained.push(...redactor.push(event));
  }
  drained.push(...redactor.finish());
  return drained;
}
