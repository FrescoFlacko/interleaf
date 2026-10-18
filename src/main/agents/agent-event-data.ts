import type { EnvironmentTestResult } from '@shared/types/agent-environment';
import type { PortableMember, PortableRecord } from '@shared/models/portable';

/** The bounded environment-inventory view of one agent-reported test frame. */
export function testResultFromEventData(data: PortableRecord): EnvironmentTestResult {
  const statusValue = data.status;
  const status: EnvironmentTestResult['status'] = statusValue === 'passed' || statusValue === 'failed' || statusValue === 'skipped' ? statusValue : 'unknown';
  return {
    status,
    summary: typeof data.message === 'string' ? data.message.slice(0, 2_000) : `Agent reported ${status} tests.`,
    exitCode: typeof data.exitCode === 'number' ? data.exitCode : status === 'passed' ? 0 : null,
    durationMs: typeof data.durationMs === 'number' ? Math.max(0, Math.min(86_400_000, Math.trunc(data.durationMs))) : null,
  };
}

export function sanitizeChangedFilesData(data: PortableRecord | undefined): PortableRecord {
  const values = data?.files;
  const files = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1_024)
      .map((value) => value.replaceAll('\\', '/'))
      .filter((value) => !value.startsWith('/') && !/^[A-Za-z]:\//u.test(value) && value !== '..' && !value.startsWith('../'))
      .slice(0, 10_000)
    : [];
  return { kind: 'changed-files', files };
}

export function extractProviderSessionId(data: PortableRecord): string | null {
  const type = typeof data.type === 'string' ? data.type : typeof data.kind === 'string' ? data.kind : '';
  const isSessionEvent = ['thread.started', 'session.started', 'thread_started', 'session_started', 'thread', 'session'].includes(type)
    || data.thread_id !== undefined
    || data.threadId !== undefined
    || data.session_id !== undefined;
  if (!isSessionEvent) return null;
  let nestedId: PortableMember;
  if (typeof data.thread === 'object' && data.thread !== null && 'id' in data.thread) {
    nestedId = data.thread.id;
  }
  const rawId = data.thread_id ?? data.threadId ?? data.session_id ?? data.sessionId ?? nestedId;
  if (typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /[\r\n\0]/u.test(trimmed)) return null;
  return trimmed;
}
