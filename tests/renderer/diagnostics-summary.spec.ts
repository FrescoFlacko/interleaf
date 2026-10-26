import { describe, expect, it } from 'vitest';
import type { DiagnosticsPacket } from '@shared/schemas/diagnostics';
import { summarizePacket } from '../../src/renderer/features/chat/diagnostics-summary';

/**
 * Main reads the local log from its oldest record forward and stops at a
 * limit, so a partial scan can only say how much it read and that the rest
 * went unchecked. It never names which records those were.
 */
function packetWith(logs: DiagnosticsPacket['logs']): DiagnosticsPacket {
  return {
    format: 'interleaf-diagnostics/1',
    collectedAt: '2026-10-25T12:00:00.000Z',
    app: { version: '0.13.1', electron: '40.1.0', chrome: '140.0.0.0', node: '22.20.0', packaging: 'packaged' },
    os: { family: 'darwin', arch: 'arm64' },
    providers: [],
    logs,
  };
}

const SIGNALS: DiagnosticsPacket['logs']['signals'] = [{ code: 'import-failed', count: 2 }];

function noteFor(logs: Partial<DiagnosticsPacket['logs']>): string | null {
  return summarizePacket(packetWith({ available: true, scannedRecords: 20000, truncated: false, counts: [], signals: [], ...logs })).logNote;
}

describe('diagnostics summary log note', () => {
  it('states the scan limit when a partial scan counted problems', () => {
    expect(noteFor({ truncated: true, signals: SIGNALS })).toBe('Counted from 20,000 log records only. The rest of the local log was not checked.');
  });

  it('keeps the scan limit when a partial scan found no problems', () => {
    expect(noteFor({ truncated: true })).toBe('No known problems were found in the 20,000 log records read. The rest of the local log was not checked.');
  });

  it('never claims which part of the log a partial scan read', () => {
    for (const signals of [SIGNALS, []]) expect(noteFor({ truncated: true, signals })).not.toMatch(/recent|latest|newest|oldest/iu);
  });

  it('stays neutral for a complete scan', () => {
    expect(noteFor({})).toBe('No known problems are recorded in the local log.');
    expect(noteFor({ signals: SIGNALS })).toBeNull();
  });

  it('counts nothing when the log could not be read', () => {
    const summary = summarizePacket(packetWith({ available: false, scannedRecords: 0, truncated: false, counts: [], signals: [] }));
    expect(summary.logNote).toBe('The local log could not be read, so no problems are counted.');
    expect(summary.signals).toEqual([]);
  });
});
