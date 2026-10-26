import type { AgentService } from '../../src/main/agents/agent-service';
import type { AgentSessionDetail, AgentSessionStatus, AgentStartResult } from '../../src/shared/types/agent';
import { rm } from 'node:fs/promises';
import type { InterleafDatabase } from '../../src/main/db/database';

export type SessionWaitOptions = {
  readonly timeoutMs: number;
  readonly expectedStatus?: AgentSessionStatus | undefined;
  readonly baselineEventCount?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
};

function isTerminalStatus(status: AgentSessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function isSessionSettled(
  session: AgentSessionDetail,
  expectedStatus: AgentSessionStatus | undefined,
  baselineEventCount: number | undefined,
): boolean {
  const { status, eventCount } = session;
  const advanced = baselineEventCount === undefined || eventCount > baselineEventCount;

  if (expectedStatus === undefined) {
    return isTerminalStatus(status) && advanced;
  }
  if (status === expectedStatus && advanced) {
    return true;
  }
  if (isTerminalStatus(status) && status !== expectedStatus) {
    throw new Error(
      `Session ${session.id} reached unexpected terminal status "${status}" (expected "${expectedStatus}"). ` +
      `Final report: ${session.finalReport ?? 'none'}.`
    );
  }
  return false;
}

/**
 * Synchronizes against the authoritative persisted session state in SQLite.
 *
 * Rejects immediately on unexpected terminal failure or when a deadline expires,
 * and ensures that resume waits do not accept the previous generation's terminal row.
 */
export async function waitForAuthoritativeSession(
  service: AgentService,
  sessionId: string,
  options: SessionWaitOptions,
): Promise<AgentSessionDetail> {
  const { timeoutMs, expectedStatus, baselineEventCount, pollIntervalMs = 5 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const session = service.getSession(sessionId);
    if (session !== null && isSessionSettled(session, expectedStatus, baselineEventCount)) {
      return session;
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setTimeout(() => { resolve(undefined); }, pollIntervalMs);
    await promise;
  }

  const current = service.getSession(sessionId);
  throw new Error(
    `Session ${sessionId} timed out waiting for ${expectedStatus !== undefined ? `"${expectedStatus}"` : 'terminal status'} ` +
    `after ${String(timeoutMs)}ms. Current status: "${current?.status ?? 'missing'}", ` +
    `eventCount: ${String(current?.eventCount ?? 0)}, liveWork: ${String(service.liveWork())}.`
  );
}

/**
 * Legacy wrapper preserving attempt-based polling semantics (5ms per attempt).
 * Uses a safe default timeout aligned with local test budgets while preserving
 * larger attempt budgets (e.g. 4_000 attempts -> 20_000ms).
 */
export async function waitForSessionStatus(
  service: AgentService,
  sessionId: string,
  expected: AgentSessionStatus,
  attempts = 100,
  options: { readonly timeoutMs?: number | undefined; readonly baselineEventCount?: number | undefined } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? (attempts > 100 ? attempts * 5 : 3_000);
  await waitForAuthoritativeSession(service, sessionId, {
    timeoutMs,
    expectedStatus: expected,
    baselineEventCount: options.baselineEventCount,
    pollIntervalMs: 5,
  });
}

/**
 * Terminal wait wrapper preserving 10ms per attempt semantics.
 * Defaults to 4_000ms (or attempts * 10 if larger), leaving headroom under local test budgets.
 */
export async function waitForTerminal(
  service: AgentService,
  sessionId: string,
  attempts = 100,
  options: { readonly timeoutMs?: number | undefined; readonly baselineEventCount?: number | undefined } = {},
): Promise<AgentSessionDetail> {
  const timeoutMs = options.timeoutMs ?? Math.max(4_000, attempts * 10);
  return waitForAuthoritativeSession(service, sessionId, {
    timeoutMs,
    baselineEventCount: options.baselineEventCount,
    pollIntervalMs: 10,
  });
}

export type ServiceFixture = {
  readonly service: AgentService;
  readonly db: InterleafDatabase;
  readonly root: string;
};

async function runStep(step: () => Promise<void> | void): Promise<Error | null> {
  try {
    await step();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Closes the database and removes the fixture root only once drain is proven
 * (no earlier failure and no live work). Otherwise both are preserved so that
 * still-running work never loses its database or files, and the first failure
 * is surfaced.
 */
async function releaseDrainedResources(
  fixture: ServiceFixture & { readonly dbClosed?: boolean },
  priorError: Error | null,
  label: string,
): Promise<void> {
  const liveCount = fixture.service.liveWork();
  const liveWorkError = liveCount > 0
    ? new Error(`Cannot tear down ${label}: service still has ${String(liveCount)} live work items after shutdown`)
    : null;
  const drainError = priorError ?? liveWorkError;
  if (drainError !== null) {
    throw drainError;
  }
  if (fixture.dbClosed !== true) {
    fixture.db.close();
  }
  await rm(fixture.root, { recursive: true, force: true });
}

/**
 * Standard AgentService fixture teardown: releases caller-owned gates, shuts
 * down and drains the service, then closes the database and removes the root
 * only when no live work remains.
 */
export async function cleanupServiceFixture(
  fixture: ServiceFixture,
  onTeardown?: () => Promise<void> | void,
): Promise<void> {
  const teardownError = onTeardown !== undefined ? await runStep(onTeardown) : null;
  const shutdownError = await runStep(() => fixture.service.shutdown());
  // Zero live work proves drain even after a teardown or shutdown failure; report it after release.
  await releaseDrainedResources(fixture, null, 'fixture');
  const primaryError = teardownError ?? shutdownError;
  if (primaryError !== null) {
    throw primaryError;
  }
}

/**
 * Observes settlement of a promise within timeoutMs, clearing its timer on
 * every path and rejecting with an error if the timeout fires.
 */
export async function observeBoundedSettlement<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for operation to settle after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type DelayedIntegrityTeardownParams = ServiceFixture & {
  /** The already-initiated shutdown; requiring it keeps shutdown ahead of any pending-operation wait. */
  readonly shutdownPromise: Promise<void>;
  readonly pendingResume: Promise<AgentStartResult | undefined> | null;
  readonly dbClosed: boolean;
};

/**
 * Tears down a delayed integrity test whose shutdown is already in flight:
 * observes bounded settlement of the pending resume, awaits the shutdown drain,
 * and preserves resources if drain is unproven.
 */
export async function teardownDelayedIntegrityTest(params: DelayedIntegrityTeardownParams): Promise<void> {
  const { pendingResume } = params;
  const settlementError = pendingResume !== null
    ? await runStep(() => observeBoundedSettlement(pendingResume, 5_000))
    : null;
  const shutdownError = await runStep(() => params.shutdownPromise);
  await releaseDrainedResources(params, settlementError ?? shutdownError, 'delayed integrity test');
}
