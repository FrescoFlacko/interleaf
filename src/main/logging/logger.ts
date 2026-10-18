/**
 * Main-process structured logging.
 *
 * Records are deliberately bounded and sanitized before they reach stdout or
 * the optional durable JSONL sink. The sink is configured during main-process
 * bootstrap; early calls remain useful through redacted console output.
 */
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, lstat, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  isPortableArray,
  isPortableRecord,
  parsePortableJson,
  type PortableRecord,
  type PortableValue,
} from '@shared/models/portable';
import type { PortableMember } from '@shared/models/portable';
import { errorHasCode } from '@shared/models/caught-error';

const LOG_CATEGORIES = [
  'app',
  'library',
  'reader',
  'indexing',
  'ai',
  'agent',
  'security',
  'database',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_LIMITS = {
  maxMessageLength: 2_000,
  maxStringLength: 4_096,
  maxRecordKeys: 64,
  maxArrayLength: 64,
  maxDepth: 6,
  maxRecordBytes: 16 * 1024,
  maxCurrentBytes: 1 * 1024 * 1024,
  retainedRotatedFiles: 3,
  maxExportBytes: 512 * 1024,
} as const;

const SECRET_KEY_PATTERN = /(?:^|[._-])(?:(?:api|auth|access|refresh|client|secret|private|signing|bearer|session|oauth|aws)[_-]?)?(?:key|token|secret|password|credential|auth|authentication|authorization)(?:$|[._-])/iu;
const CONFIDENTIAL_BODY_KEY_PATTERN = /^(?:document(?:body|content|text)?|prompt|context(?:packet|text)?|(?:raw)?(?:stdout|stderr)|(?:raw)?(?:text|body|content|excerpt|quote))$/iu;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
  /\b(?:sk|rk|pk|AIza|gh[pousr]|xox[baprs]|npm)[-_][A-Za-z0-9._-]{8,}\b/gu,
  /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|APKA|ASCA)[A-Z0-9]{16}\b/gu,
] as const;
const SECRET_ASSIGNMENT_KEY_PATTERN = /\b(?:api(?:[-_.]?key)?|auth(?:entication|orization)?|access[-_.]?token|refresh[-_.]?token|client[-_.]?secret|token|password|secret|credential|private[-_.]?key|signing[-_.]?key|bearer[-_.]?token|session[-_.]?token|oauth[-_.]?token|aws[-_.]?(?:key|token|secret))\b/giu;

const HOME_PATH_PATTERNS = [
  /\/(?:Users|home)\/[^/\\\s"'`,;)]*/gu,
  /[A-Za-z]:\\Users\\[^\\\s"'`,;)]*/gu,
  /(?:^|[\s=(])~(?=\/|\\)/gu,
] as const;

/** A bounded, portable record written one-per-line by the durable sink. */
type LogRecord = {
  readonly timestamp: string;
  readonly category: LogCategory;
  readonly level: LogLevel;
  readonly message: string;
  readonly meta?: LogMeta;
};

/**
 * Diagnostic metadata attached to a log line. Portable values only: a log
 * record is serialized to one JSON line, and every value passes the redaction
 * boundary below before it is written.
 */
export type LogMeta = PortableRecord;

export type Logger = {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
};

export type DurableLogSinkOptions = {
  readonly directory: string;
  readonly debugEnabled?: boolean;
  readonly maxCurrentBytes?: number;
  readonly retainedRotatedFiles?: number;
  readonly maxExportBytes?: number;
};

export type DurableLogExport = {
  readonly bytes: number;
  readonly fileName: string;
};

const noFollowFlag = 'O_NOFOLLOW' in fsConstants
  ? (fsConstants as { readonly O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

let activeSink: DurableLogSink | null = null;

/** Redacts and bounds metadata at the one shared logging boundary. */
export function redactSecrets(meta: LogMeta): LogMeta {
  return redactRecord(meta, new WeakSet<object>(), 0);
}

function redactRecord(
  value: LogMeta,
  seen: WeakSet<object>,
  depth: number,
): LogMeta {
  if (seen.has(value)) return { redacted: '[circular]' };
  if (depth >= LOG_LIMITS.maxDepth) return { redacted: '[depth-limit]' };
  seen.add(value);
  const result: Record<string, PortableValue> = {};
  const entries = Object.entries(value);
  const entryLimit = entries.length > LOG_LIMITS.maxRecordKeys ? LOG_LIMITS.maxRecordKeys - 1 : LOG_LIMITS.maxRecordKeys;
  for (const [key, entry] of entries.slice(0, entryLimit)) {
    const normalizedKey = key.slice(0, 256);
    result[normalizedKey] = isSecretKey(normalizedKey) || CONFIDENTIAL_BODY_KEY_PATTERN.test(normalizedKey)
      ? '[redacted]'
      : redactValue(entry, seen, depth + 1);
  }
  if (entries.length > LOG_LIMITS.maxRecordKeys) result._redacted = '[key-limit]';
  return result;
}

function redactValue(value: PortableValue, seen: WeakSet<object>, depth: number): PortableValue {
  if (typeof value === 'string') {
    const redacted = redactStringWithFlags(value);
    // Metadata strings that contain an assignment are treated as a single
    // secret-bearing value. Do not preserve surrounding diagnostics such as
    // `token=[redacted]` when the existing metadata contract requires the
    // entire field to be opaque.
    return redacted.secretDetected ? '[redacted]' : redacted.value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= LOG_LIMITS.maxDepth) return '[depth-limit]';
  if (isPortableArray(value)) {
    const entryLimit = value.length > LOG_LIMITS.maxArrayLength ? LOG_LIMITS.maxArrayLength - 1 : LOG_LIMITS.maxArrayLength;
    const entries = value.slice(0, entryLimit).map((entry) => redactValue(entry, seen, depth + 1));
    if (value.length > LOG_LIMITS.maxArrayLength) entries.push('[array-limit]');
    return entries;
  }
  if (typeof value === 'object') {
    if (!isPortableRecord(value) || Object.prototype.toString.call(value) !== '[object Object]') return '[object-redacted]';
    return redactRecord(value, seen, depth + 1);
  }
  return `[${typeof value}-redacted]`;
}

/** An exported line names its own category and level; anything else is untrusted text. */
function isLogCategory(value: PortableMember): value is LogCategory {
  return LOG_CATEGORIES.some((category) => category === value);
}

function isLogLevel(value: PortableMember): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
  return redactStringWithFlags(value).value;
}

type RedactedString = {
  readonly value: string;
  readonly secretDetected: boolean;
};

function redactStringWithFlags(value: string): RedactedString {
  // Bound work before scanning attacker-controlled strings. Secrets after the
  // retained prefix cannot be emitted because the result is bounded as well.
  let redacted = value.length > LOG_LIMITS.maxStringLength
    ? value.slice(0, LOG_LIMITS.maxStringLength)
    : value;
  const assignmentResult = redactSecretAssignments(redacted);
  redacted = assignmentResult.value;
  let secretDetected = assignmentResult.secretDetected;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const replaced = redacted.replace(pattern, '[redacted]');
    secretDetected ||= replaced !== redacted;
    redacted = replaced;
  }
  for (const pattern of HOME_PATH_PATTERNS) redacted = redacted.replace(pattern, (match) => {
    if (match.startsWith('~')) return '[user-home]';
    if (match.startsWith('C:') || match.startsWith('c:')) return 'C:\\[user-home]';
    return match.startsWith('/') ? '/[user-home]' : `${match.slice(0, -1)}[user-home]`;
  });
  const hostHome = homedir();
  if (hostHome.length > 1) redacted = redacted.split(hostHome).join('[user-home]');
  return { value: truncate(redacted, LOG_LIMITS.maxStringLength), secretDetected };
}

/**
 * Redacts `key=value`/`key: value` assignments without regex quoted-string
 * parsing. Escapes are consumed one character at a time, so an escaped quote
 * cannot terminate the value early and expose its suffix.
 */
function redactSecretAssignments(value: string): { readonly value: string; readonly secretDetected: boolean } {
  let output = '';
  let copiedThrough = 0;
  let secretDetected = false;
  SECRET_ASSIGNMENT_KEY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT_KEY_PATTERN.exec(value)) !== null) {
    const keyStart = match.index;
    if (keyStart < copiedThrough) continue;
    let cursor = SECRET_ASSIGNMENT_KEY_PATTERN.lastIndex;
    while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
    // Permit JSON-like quoted keys: "password": "value".
    if (value[cursor] === '"' || value[cursor] === "'") {
      cursor += 1;
      while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
    }
    if (value[cursor] !== '=' && value[cursor] !== ':') continue;
    cursor += 1;
    while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
    const valueStart = cursor;
    if (cursor >= value.length) continue;

    const quote = value[cursor];
    if (quote === '"' || quote === "'" || quote === '`') {
      cursor += 1;
      let escaped = false;
      while (cursor < value.length) {
        const character = value[cursor];
        cursor += 1;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          break;
        }
      }
    } else {
      // Consume the whole unquoted field up to a structural delimiter. This
      // also covers `authorization=Bearer token with spaces` safely.
      while (cursor < value.length && !isAssignmentBoundary(value[cursor])) cursor += 1;
    }

    output += value.slice(copiedThrough, valueStart);
    output += '[redacted]';
    secretDetected = true;
    copiedThrough = cursor;
    SECRET_ASSIGNMENT_KEY_PATTERN.lastIndex = cursor;
  }
  SECRET_ASSIGNMENT_KEY_PATTERN.lastIndex = 0;
  return { value: `${output}${value.slice(copiedThrough)}`, secretDetected };
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isAssignmentBoundary(character: string | undefined): boolean {
  return character === undefined || character === ',' || character === ';' || character === '&' ||
    character === '|' || character === '\n' || character === '\r' || character === ')' ||
    character === ']' || character === '}';
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 15))}…[truncated]`;
}

function createSerializedRecord(
  category: LogCategory,
  level: LogLevel,
  message: string,
  meta?: LogMeta,
): string {
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    category,
    level,
    message: truncate(redactString(message), LOG_LIMITS.maxMessageLength),
    ...(meta === undefined ? {} : { meta: redactSecrets(meta) }),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    serialized = JSON.stringify({ timestamp: record.timestamp, category, level, message: '[unserializable-log-record]' });
  }
  if (Buffer.byteLength(serialized, 'utf8') <= LOG_LIMITS.maxRecordBytes) return serialized;
  return JSON.stringify({
    timestamp: record.timestamp,
    category,
    level,
    message: truncate(record.message, 512),
    meta: { redacted: '[record-limit]' },
  });
}

function emit(category: LogCategory, level: LogLevel, message: string, meta?: LogMeta): void {
  if (level === 'debug' && !(activeSink?.debugEnabled ?? false)) return;
  const serialized = createSerializedRecord(category, level, message, meta);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
  activeSink?.append(serialized);
}

export function createLogger(category: LogCategory): Logger {
  return {
    debug: (message, meta) => { emit(category, 'debug', message, meta); },
    info: (message, meta) => { emit(category, 'info', message, meta); },
    warn: (message, meta) => { emit(category, 'warn', message, meta); },
    error: (message, meta) => { emit(category, 'error', message, meta); },
  };
}

/** Main-owned durable JSONL sink. Writes are serialized and fail closed. */
export class DurableLogSink {
  readonly directory: string;
  readonly currentPath: string;
  /**
   * Whether debug records are kept. It is settable because the preference that
   * drives it is loaded after bootstrap has already configured the sink, and
   * because the user may change it while the application is running. Only the
   * level filter moves: destination, bounds, rotation and redaction are fixed.
   */
  private debugRecordsEnabled: boolean;
  private readonly maxCurrentBytes: number;
  private readonly retainedRotatedFiles: number;
  private readonly maxExportBytes: number;
  private writeTail: Promise<void> = Promise.resolve();
  private disabled = false;

  constructor(options: DurableLogSinkOptions) {
    this.directory = options.directory;
    this.currentPath = join(options.directory, 'interleaf.log');
    this.debugRecordsEnabled = options.debugEnabled === true;
    this.maxCurrentBytes = options.maxCurrentBytes ?? LOG_LIMITS.maxCurrentBytes;
    this.retainedRotatedFiles = Math.max(0, Math.min(options.retainedRotatedFiles ?? LOG_LIMITS.retainedRotatedFiles, 8));
    this.maxExportBytes = Math.max(16 * 1024, Math.min(options.maxExportBytes ?? LOG_LIMITS.maxExportBytes, 2 * 1024 * 1024));
  }

  get debugEnabled(): boolean {
    return this.debugRecordsEnabled;
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugRecordsEnabled = enabled;
  }

  append(serializedRecord: string): void {
    if (this.disabled) return;
    this.writeTail = this.writeTail.then(() => this.appendOne(serializedRecord)).catch(() => {
      this.disabled = true;
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  async exportTo(destinationPath: string): Promise<DurableLogExport> {
    await this.flush();
    const contents = await this.readSanitizedLogs();
    await writeRestrictedFile(destinationPath, contents);
    return { bytes: Buffer.byteLength(contents, 'utf8'), fileName: basename(destinationPath) };
  }

  private async appendOne(serializedRecord: string): Promise<void> {
    if (this.disabled) return;
    await ensureRestrictedDirectory(this.directory);
    await validateManagedLogFiles(this.directory, this.retainedRotatedFiles);
    const payload = `${serializedRecord}\n`;
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.currentPath)).size;
    } catch (error) {
      if (!isNotFound(error instanceof Error ? error : null)) throw error;
    }
    if (currentBytes + Buffer.byteLength(payload, 'utf8') > this.maxCurrentBytes) await this.rotate();
    const handle = await open(this.currentPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(payload, { encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  }

  private async rotate(): Promise<void> {
    await validateManagedLogFiles(this.directory, this.retainedRotatedFiles);
    if (this.retainedRotatedFiles === 0) {
      if (await exists(this.currentPath)) await unlinkIfRegular(this.currentPath);
      return;
    }
    for (let index = this.retainedRotatedFiles; index >= 1; index -= 1) {
      const source = index === 1 ? this.currentPath : `${this.currentPath}.${String(index - 1)}`;
      const destination = `${this.currentPath}.${String(index)}`;
      if (!(await exists(source))) continue;
      if (await exists(destination)) await unlinkIfRegular(destination);
      await rename(source, destination);
      await chmod(destination, 0o600);
    }
  }

  private async readSanitizedLogs(): Promise<string> {
    await ensureRestrictedDirectory(this.directory);
    await validateManagedLogFiles(this.directory, this.retainedRotatedFiles);
    const paths: string[] = [];
    for (let index = this.retainedRotatedFiles; index >= 1; index -= 1) {
      const path = `${this.currentPath}.${String(index)}`;
      if (await exists(path)) paths.push(path);
    }
    if (await exists(this.currentPath)) paths.push(this.currentPath);

    let output = '';
    for (const path of paths) {
      const text = await readFile(path, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        const sanitized = sanitizeExportLine(line);
        if (sanitized === null) continue;
        const candidate = `${sanitized}\n`;
        if (Buffer.byteLength(output, 'utf8') + Buffer.byteLength(candidate, 'utf8') > this.maxExportBytes) return output;
        output += candidate;
      }
    }
    return output;
  }
}

function sanitizeExportLine(line: string): string | null {
  try {
    const parsed = parsePortableJson(line);
    if (!isPortableRecord(parsed)) return null;
    const record: PortableRecord = parsed;
    const category = isLogCategory(record.category) ? record.category : 'app';
    const level = isLogLevel(record.level) ? record.level : 'info';
    const message = typeof record.message === 'string' ? record.message : '[invalid-log-message]';
    const meta = isPortableRecord(record.meta)
      ? redactSecrets(record.meta)
      : undefined;
    return createSerializedRecord(category, level, message, meta);
  } catch {
    return null;
  }
}

async function ensureRestrictedDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Log directory is not a regular directory.');
  } catch (error) {
    if (!isNotFound(error instanceof Error ? error : null)) throw error;
    await mkdir(directory, { recursive: false, mode: 0o700 });
  }
  const checked = await lstat(directory);
  if (!checked.isDirectory() || checked.isSymbolicLink()) throw new Error('Log directory is not a regular directory.');
  await chmod(directory, 0o700);
}

async function validateManagedLogFiles(directory: string, retained: number): Promise<void> {
  const names = ['interleaf.log', ...Array.from({ length: retained }, (_, index) => `interleaf.log.${String(index + 1)}`)];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe log file: ${name}`);
      await chmod(path, 0o600);
    } catch (error) {
      if (!isNotFound(error instanceof Error ? error : null)) throw error;
    }
  }
}

async function unlinkIfRegular(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to remove unsafe log file.');
  await unlink(path);
}

async function writeRestrictedFile(destinationPath: string, contents: string): Promise<void> {
  if (destinationPath.length === 0 || destinationPath.includes('\0')) throw new Error('Invalid debug log destination.');
  const parent = dirname(destinationPath);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('Debug log destination directory is unsafe.');
  try {
    const existing = await lstat(destinationPath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Debug log destination is unsafe.');
  } catch (error) {
    if (!isNotFound(error instanceof Error ? error : null)) throw error;
  }
  const handle = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollowFlag, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error instanceof Error ? error : null)) return false;
    throw error;
  }
}

function isNotFound(caught: Error | null): boolean {
  return errorHasCode(caught, 'ENOENT');
}

export function configureDurableLogging(options: DurableLogSinkOptions): DurableLogSink {
  const sink = new DurableLogSink(options);
  activeSink = sink;
  return sink;
}

/**
 * Applies the user's diagnostic-logging preference to the active sink.
 *
 * Only the level filter moves. The destination, size bounds, rotation and
 * redaction of the durable sink are fixed at configuration time, so this can be
 * applied while the application runs without any restart.
 */
export function setDurableDebugLogging(enabled: boolean): void {
  activeSink?.setDebugEnabled(enabled);
}

export async function flushDurableLogs(): Promise<void> {
  await activeSink?.flush();
}

/** Test/bootstrap isolation hook; not exposed through preload or IPC. */
export function resetDurableLogging(): void {
  activeSink = null;
}
