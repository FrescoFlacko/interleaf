import type { AgentEvent } from '@shared/types/agent';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, isPortableRecord, parsePortableJson } from '@shared/models/portable';

export type ActivityItemStatus = 'running' | 'completed' | 'failed';

export type ActivityTodoItem = {
  readonly task: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
};

type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'changed';

export type NormalizedAgentActivity =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly text: string;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly command: string;
      readonly status: ActivityItemStatus;
      readonly exitCode?: number | null | undefined;
      readonly output?: string | null | undefined;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'file_change';
      readonly id: string;
      readonly path: string;
      readonly status?: FileChangeStatus | undefined;
      readonly additions?: number | null | undefined;
      readonly deletions?: number | null | undefined;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'todo_list';
      readonly id: string;
      readonly todos: readonly ActivityTodoItem[];
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'test_run';
      readonly id: string;
      readonly summary?: string | undefined;
      readonly passed?: number | undefined;
      readonly failed?: number | undefined;
      readonly total?: number | undefined;
      readonly status: ActivityItemStatus;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'final';
      readonly id: string;
      readonly text: string;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'error';
      readonly id: string;
      readonly message: string;
      readonly code?: string | undefined;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'lifecycle';
      readonly id: string;
      readonly eventType: 'started' | 'ended' | 'cancelled';
      readonly exitCode?: number | null | undefined;
      readonly signal?: string | null | undefined;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: 'log';
      readonly id: string;
      readonly stream: 'stdout' | 'stderr';
      readonly text: string;
      readonly timestamp?: string | undefined;
    };

const HIDDEN_PROTOCOL_TYPES: ReadonlySet<string> = new Set([
  'thread.started',
  'thread_started',
  'thread.created',
  'thread_created',
  'turn.started',
  'turn_started',
  'turn.completed',
  'turn_completed',
  'session.started',
  'session_started',
  'session.completed',
  'session_completed',
]);

/**
 * Checks if a stdout text line is a raw JSON envelope that should not be
 * displayed as raw unparsed text in the high-signal activity log.
 */
export function isRawJsonStdout(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const parsed: PortableValue = parsePortableJson(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Parses truthful addition and deletion line counts from a unified diff string.
 * Lines starting with '+' (excluding '+++') count as additions.
 * Lines starting with '-' (excluding '---') count as deletions.
 */
export function parseDiffLineCounts(diff: string): { additions: number; deletions: number } | null {
  if (typeof diff !== 'string' || diff.trim().length === 0) return null;
  const lines = diff.split(/\r?\n/u);
  let additions = 0;
  let deletions = 0;
  let hasDiffHunks = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      hasDiffHunks = true;
      continue;
    }
    if (!hasDiffHunks) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
    }
  }

  return hasDiffHunks ? { additions, deletions } : null;
}

function extractItemPayload(data: PortableRecord): {
  type: string;
  id?: string | undefined;
  itemData: PortableRecord;
  eventType?: string | undefined;
} {
  const eventType = typeof data.type === 'string' ? data.type : typeof data.kind === 'string' ? data.kind : undefined;
  const itemObj = data.item;
  if (isPortableRecord(itemObj)) {
    const itemRecord = itemObj;
    const itemType = typeof itemRecord.type === 'string' ? itemRecord.type : typeof itemRecord.kind === 'string' ? itemRecord.kind : (eventType ?? '');
    const id = typeof itemRecord.id === 'string' ? itemRecord.id : typeof data.id === 'string' ? data.id : undefined;
    return { type: itemType, id, itemData: itemRecord, eventType };
  }
  const id = typeof data.id === 'string' ? data.id : undefined;
  return { type: eventType ?? '', id, itemData: data, eventType };
}

function parseTodos(rawTodos: PortableValue): readonly ActivityTodoItem[] {
  if (!isPortableArray(rawTodos)) return [];
  const items: ActivityTodoItem[] = [];
  for (const entry of rawTodos) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      items.push({ task: entry.trim(), status: 'pending' });
    } else if (isPortableRecord(entry)) {
      const record = entry;
      const taskText = typeof record.task === 'string' ? record.task : typeof record.text === 'string' ? record.text : typeof record.title === 'string' ? record.title : '';
      if (!taskText.trim()) continue;
      const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase() : '';
      const isCompleted = record.completed === true || rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'finished';
      const isFailed = rawStatus === 'failed' || rawStatus === 'error';
      const isInProgress = rawStatus === 'in_progress' || rawStatus === 'running' || rawStatus === 'working';
      const status = isCompleted ? 'completed' : isFailed ? 'failed' : isInProgress ? 'in_progress' : 'pending';
      items.push({ task: taskText.trim(), status });
    }
  }
  return items;
}
function normalizeFileChangeStatus(rawStatus: PortableMember): FileChangeStatus {
  if (typeof rawStatus !== 'string') return 'modified';
  const lower = rawStatus.toLowerCase().trim();
  if (lower === 'add' || lower === 'added' || lower === 'create' || lower === 'created' || lower === 'new') {
    return 'added';
  }
  if (lower === 'delete' || lower === 'deleted' || lower === 'remove' || lower === 'removed') {
    return 'deleted';
  }
  if (lower === 'rename' || lower === 'renamed' || lower === 'move' || lower === 'moved') {
    return 'renamed';
  }
  return 'modified';
}

type ExtractedFileChange = {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
};

function extractFileChanges(itemData: PortableRecord): readonly ExtractedFileChange[] {
  const rawList = isPortableArray(itemData.changes)
    ? itemData.changes
    : isPortableArray(itemData.files)
      ? itemData.files
      : undefined;

  if (rawList !== undefined) {
    const results: ExtractedFileChange[] = [];
    for (const entry of rawList) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        results.push({
          path: entry.trim(),
          status: 'modified',
          additions: null,
          deletions: null,
        });
      } else if (isPortableRecord(entry)) {
        const record = entry;
        const rawPath = typeof record.path === 'string'
          ? record.path
          : typeof record.file === 'string'
            ? record.file
            : typeof record.filename === 'string'
              ? record.filename
              : '';
        if (!rawPath.trim()) continue;
        const status = normalizeFileChangeStatus(record.kind ?? record.status ?? record.type);
        let additions: number | null = typeof record.additions === 'number' ? record.additions : null;
        let deletions: number | null = typeof record.deletions === 'number' ? record.deletions : null;
        if (additions === null && deletions === null && typeof record.diff === 'string') {
          const diffCounts = parseDiffLineCounts(record.diff);
          if (diffCounts !== null) {
            additions = diffCounts.additions;
            deletions = diffCounts.deletions;
          }
        }
        results.push({
          path: rawPath.trim(),
          status,
          additions,
          deletions,
        });
      }
    }
    return results;
  }

  const singlePath = typeof itemData.path === 'string'
    ? itemData.path
    : typeof itemData.file === 'string'
      ? itemData.file
      : '';
  if (singlePath.trim().length > 0) {
    const status = normalizeFileChangeStatus(itemData.kind ?? itemData.status ?? itemData.type);
    let additions: number | null = typeof itemData.additions === 'number' ? itemData.additions : null;
    let deletions: number | null = typeof itemData.deletions === 'number' ? itemData.deletions : null;
    if (additions === null && deletions === null && typeof itemData.diff === 'string') {
      const diffCounts = parseDiffLineCounts(itemData.diff);
      if (diffCounts !== null) {
        additions = diffCounts.additions;
        deletions = diffCounts.deletions;
      }
    }
    return [{
      path: singlePath.trim(),
      status,
      additions,
      deletions,
    }];
  }

  return [];
}

function scopeItemId(rawId: string, runIndex: number, turnIndex: number): string {
  if (runIndex === 0 && turnIndex === 0) return rawId;
  if (turnIndex === 0) return `r${String(runIndex)}:${rawId}`;
  return `r${String(runIndex)}_t${String(turnIndex)}:${rawId}`;
}

/**
 * Normalizes raw and structured agent events into high-signal activity items,
 * hiding protocol plumbing, suppressing duplicate raw stdout, and coalescing
 * matching item.started / item.completed pairs scoped to each execution/run boundary.
 */
export function normalizeAgentEvents(events: readonly AgentEvent[]): readonly NormalizedAgentActivity[] {
  const items: NormalizedAgentActivity[] = [];
  let indexById = new Map<string, number>();
  let runIndex = -1;
  let turnIndex = 0;

  for (const event of events) {
    if (event.type === 'started') {
      runIndex += 1;
      turnIndex = 0;
      indexById = new Map<string, number>();
      items.push({
        kind: 'lifecycle',
        id: `started-${String(event.ordinal)}`,
        eventType: 'started',
        timestamp: event.timestamp,
      });
      continue;
    }

    const currentRun = Math.max(0, runIndex);

    if (event.type === 'ended') {
      items.push({
        kind: 'lifecycle',
        id: `ended-${String(event.ordinal)}`,
        eventType: 'ended',
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'cancelled') {
      items.push({
        kind: 'lifecycle',
        id: `cancelled-${String(event.ordinal)}`,
        eventType: 'cancelled',
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'error') {
      items.push({
        kind: 'error',
        id: `error-${String(event.ordinal)}`,
        message: event.error.message,
        code: event.error.code,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'final') {
      items.push({
        kind: 'final',
        id: `final-${String(event.ordinal)}`,
        text: event.text,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'stdout' || event.type === 'stderr') {
      const text = event.text;
      // Hide raw JSON stdout (Codex and other JSON-streaming agents emit JSON lines to stdout)
      if (event.type === 'stdout' && isRawJsonStdout(text)) {
        continue;
      }
      if (text.trim().length > 0) {
        items.push({
          kind: 'log',
          id: `log-${String(event.ordinal)}`,
          stream: event.type,
          text,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type === 'changed-files') {
      const files = Array.isArray(event.data.files) ? event.data.files : [];
      for (const file of files) {
        const filePath = String(file);
        if (!filePath) continue;
        const rawFileId = `file-${filePath}`;
        const scopedFileId = scopeItemId(rawFileId, currentRun, turnIndex);
        const existingIdx = indexById.get(scopedFileId);
        const item: NormalizedAgentActivity = {
          kind: 'file_change',
          id: scopedFileId,
          path: filePath,
          status: 'modified',
          timestamp: event.timestamp,
        };
        if (existingIdx !== undefined) {
          items[existingIdx] = item;
        } else {
          indexById.set(scopedFileId, items.length);
          items.push(item);
        }
      }
      continue;
    }

    if (event.type === 'tests') {
      const data = event.data;
      const passed = typeof data.passed === 'number' ? data.passed : undefined;
      const failed = typeof data.failed === 'number' ? data.failed : undefined;
      const total = typeof data.total === 'number' ? data.total : undefined;
      const summary = typeof data.summary === 'string' ? data.summary : typeof data.text === 'string' ? data.text : undefined;
      const status: ActivityItemStatus = (failed !== undefined && failed > 0) ? 'failed' : 'completed';
      items.push({
        kind: 'test_run',
        id: `test-${String(event.ordinal)}`,
        passed,
        failed,
        total,
        summary,
        status,
        timestamp: event.timestamp,
      });
      continue;
    }

    // Every other event type was handled above; what remains is a structured frame.
    const { type, id, itemData, eventType } = extractItemPayload(event.data);

    // Structured turn start boundaries
    if (
      type === 'turn.started' || type === 'turn_started'
      || (eventType !== undefined && (eventType === 'turn.started' || eventType === 'turn_started'))
    ) {
      turnIndex += 1;
      indexById = new Map<string, number>();
      continue;
    }

    // Hide protocol plumbing
    if (HIDDEN_PROTOCOL_TYPES.has(type) || (eventType !== undefined && HIDDEN_PROTOCOL_TYPES.has(eventType))) {
      continue;
    }

    // 1. Agent message / assistant message
    if (type === 'agent_message' || type === 'message' || type === 'assistant_message') {
      const messageText = typeof itemData.text === 'string'
        ? itemData.text
        : typeof itemData.message === 'string'
          ? itemData.message
          : typeof itemData.content === 'string'
            ? itemData.content
            : '';
      if (messageText.trim().length === 0) continue;
      const rawMsgId = id ?? `msg-${String(event.ordinal)}`;
      const scopedMsgId = scopeItemId(rawMsgId, currentRun, turnIndex);
      const existingIdx = id !== undefined ? indexById.get(scopedMsgId) : undefined;
      const item: NormalizedAgentActivity = {
        kind: 'message',
        id: scopedMsgId,
        text: messageText,
        timestamp: event.timestamp,
      };
      if (existingIdx !== undefined) {
        items[existingIdx] = item;
      } else {
        if (id !== undefined) indexById.set(scopedMsgId, items.length);
        items.push(item);
      }
      continue;
    }

    // 2. Command execution
    if (type === 'command_execution' || type === 'command' || type === 'exec' || type === 'bash' || typeof itemData.command === 'string') {
      const commandStr = typeof itemData.command === 'string' ? itemData.command : typeof itemData.cmd === 'string' ? itemData.cmd : '';
      const exitCode = typeof itemData.exit_code === 'number'
        ? itemData.exit_code
        : typeof itemData.exitCode === 'number'
          ? itemData.exitCode
          : null;
      const rawOutput = typeof itemData.aggregated_output === 'string'
        ? itemData.aggregated_output
        : typeof itemData.output === 'string'
          ? itemData.output
          : typeof itemData.stdout === 'string'
            ? itemData.stdout
            : typeof itemData.result === 'string'
              ? itemData.result
              : null;
      const output = rawOutput !== null
        ? (rawOutput.length > 50_000 ? `${rawOutput.slice(0, 50_000)}\n… [output bounded]` : rawOutput)
        : null;
      const isCompleted = eventType === 'item.completed' || exitCode !== null || typeof itemData.aggregated_output === 'string';
      const isFailed = exitCode !== null && exitCode !== 0;
      const status: ActivityItemStatus = isFailed ? 'failed' : isCompleted ? 'completed' : 'running';

      const rawCmdId = id ?? `cmd-${String(event.ordinal)}`;
      const scopedCmdId = scopeItemId(rawCmdId, currentRun, turnIndex);
      const existingIdx = id !== undefined ? indexById.get(scopedCmdId) : undefined;
      const item: NormalizedAgentActivity = {
        kind: 'command',
        id: scopedCmdId,
        command: commandStr || '(command)',
        status,
        exitCode,
        output,
        timestamp: event.timestamp,
      };

      if (existingIdx !== undefined) {
        const prev = items[existingIdx];
        if (prev?.kind === 'command') {
          items[existingIdx] = {
            ...prev,
            status: isFailed ? 'failed' : isCompleted ? 'completed' : prev.status,
            exitCode: exitCode ?? prev.exitCode,
            output: output ?? prev.output,
            command: commandStr || prev.command,
          };
        } else {
          items[existingIdx] = item;
        }
      } else {
        if (id !== undefined) indexById.set(scopedCmdId, items.length);
        items.push(item);
      }
      continue;
    }

    // 3. File changes
    if (
      type === 'file_change' || type === 'file_edit' || type === 'file_patch'
      || typeof itemData.changes !== 'undefined'
      || typeof itemData.path === 'string'
      || typeof itemData.file === 'string'
    ) {
      const fileChanges = extractFileChanges(itemData);
      if (fileChanges.length > 0) {
        for (const change of fileChanges) {
          const rawFileId = id !== undefined ? `${id}:${change.path}` : `file-${change.path}`;
          const scopedFileId = scopeItemId(rawFileId, currentRun, turnIndex);
          const existingIdx = indexById.get(scopedFileId);
          const item: NormalizedAgentActivity = {
            kind: 'file_change',
            id: scopedFileId,
            path: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            timestamp: event.timestamp,
          };

          if (existingIdx !== undefined) {
            const prev = items[existingIdx];
            if (prev?.kind === 'file_change') {
              items[existingIdx] = {
                ...prev,
                status: change.status,
                additions: change.additions ?? prev.additions,
                deletions: change.deletions ?? prev.deletions,
              };
            } else {
              items[existingIdx] = item;
            }
          } else {
            indexById.set(scopedFileId, items.length);
            items.push(item);
          }
        }
        continue;
      }
    }

    // 4. Todo / Checklist changes
    if (type === 'todo_list' || type === 'todo' || type === 'todos' || itemData.todos !== undefined || itemData.items !== undefined) {
      const rawTodos = itemData.todos ?? itemData.items ?? (type === 'todo' ? [itemData] : []);
      const todos = parseTodos(rawTodos);
      if (todos.length > 0) {
        const rawTodoId = id ?? 'todo-list';
        const scopedTodoId = scopeItemId(rawTodoId, currentRun, turnIndex);
        const existingIdx = indexById.get(scopedTodoId);
        const item: NormalizedAgentActivity = {
          kind: 'todo_list',
          id: scopedTodoId,
          todos,
          timestamp: event.timestamp,
        };
        if (existingIdx !== undefined) {
          items[existingIdx] = item;
        } else {
          indexById.set(scopedTodoId, items.length);
          items.push(item);
        }
        continue;
      }
    }

    // 5. Result / Final in structured
    if (type === 'result' || type === 'final') {
      const resultText = typeof itemData.result === 'string' ? itemData.result : typeof itemData.text === 'string' ? itemData.text : '';
      if (resultText.trim().length > 0) {
        const rawResultId = id ?? `result-${String(event.ordinal)}`;
        const scopedResultId = scopeItemId(rawResultId, currentRun, turnIndex);
        items.push({
          kind: 'final',
          id: scopedResultId,
          text: resultText,
          timestamp: event.timestamp,
        });
        continue;
      }
    }

    // 6. Generic error inside structured event
    if (type === 'error') {
      const errorMessage = typeof itemData.message === 'string'
        ? itemData.message
        : typeof itemData.error === 'string'
          ? itemData.error
          : 'Agent encountered an error.';
      const rawErrorId = id ?? `error-${String(event.ordinal)}`;
      const scopedErrorId = scopeItemId(rawErrorId, currentRun, turnIndex);
      items.push({
        kind: 'error',
        id: scopedErrorId,
        message: errorMessage,
        timestamp: event.timestamp,
      });
    }
  }

  return items;
}
