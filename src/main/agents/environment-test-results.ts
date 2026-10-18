/**
 * The bounded test-result inventory an agent environment records.
 *
 * What a run may report is capped before it reaches main-process work, and
 * what a restart reads back is validated leaf by leaf: a recovered metadata
 * document is untrusted until each result satisfies the published shape.
 */
import type { EnvironmentTestResult } from '@shared/types/agent-environment';
import { isPortableArray, isPortableRecord, type PortableValue } from '@shared/models/portable';

/** Admitted test results per run: 127 individual results plus the one
 * coalesced summary standing for everything refused after them. */
export const MAX_TEST_RESULTS = 128;
/** Durable history across every run of a session. Each resume opens a fresh
 * admission window, so the inventory is bounded per run *and* overall; the
 * oldest entries are dropped once this ceiling is reached. */
export const MAX_RETAINED_TEST_RESULTS = 512;

/** The recorded test results on a recovered environment metadata document. */
export function readTestResults(metadata: PortableValue): readonly EnvironmentTestResult[] {
  if (!isPortableRecord(metadata) || !isPortableArray(metadata.tests)) return [];
  return metadata.tests.filter(isSafeTestResult).slice(-MAX_RETAINED_TEST_RESULTS);
}

/** The coalesced count of test results reported after the per-run cap. */
export function readSuppressedTests(metadata: PortableValue): number {
  const suppressed = isPortableRecord(metadata) ? metadata.suppressedTests : undefined;
  return typeof suppressed === 'number' && Number.isSafeInteger(suppressed) && suppressed > 0 ? suppressed : 0;
}

/**
 * The single entry standing for every result reported after the cap. It is
 * rewritten in place, so a flood of any size adds exactly one bounded row.
 */
export function coalescedTestSummary(suppressed: number, latest: EnvironmentTestResult): EnvironmentTestResult {
  return {
    status: 'unknown',
    summary: `${String(suppressed)} further test result${suppressed === 1 ? '' : 's'} were reported after this run's ${String(MAX_TEST_RESULTS)}-result limit and were not recorded individually. Most recent reported status: ${latest.status}.`,
    exitCode: null,
    durationMs: null,
  };
}

function isSafeTestResult(value: PortableValue): value is EnvironmentTestResult {
  if (!isPortableRecord(value)) return false;
  const record = value;
  return (record.status === 'passed' || record.status === 'failed' || record.status === 'skipped' || record.status === 'unknown') && typeof record.summary === 'string' && record.summary.length <= 2_000 && (record.exitCode === null || typeof record.exitCode === 'number') && (record.durationMs === null || typeof record.durationMs === 'number');
}
