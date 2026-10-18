import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * A scripted child process.
 *
 * The process runner and the CLI providers drive a real `spawn` result: three
 * pipes, a pid, a kill that may or may not be delivered, and the `error`/`close`
 * events. A boundary test needs to script exactly those without starting a
 * program, so this answers the whole `ChildProcessWithoutNullStreams` contract
 * over live `PassThrough` streams. The test writes to `stdout`/`stderr`, calls
 * {@link close} or {@link fail}, and reads back the signals it was killed with.
 */
export class TestChildProcess extends EventEmitter implements ChildProcessWithoutNullStreams {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  readonly spawnfile = 'test-child';
  readonly spawnargs: string[] = [];
  readonly channel = null;
  readonly connected = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  /** Every signal `kill` was called with, in order. */
  readonly killSignals: (NodeJS.Signals | number)[] = [];

  /** When set, `kill` records the signal and reports failure to deliver it. */
  killFails = false;

  /**
   * The only signal this child dies from. A child that traps `SIGTERM` accepts
   * the signal and keeps running; a test sets this to `SIGKILL` to reproduce
   * that and make the runner escalate. While it is set, every `kill` reports a
   * delivered signal, and only a matching one closes the child.
   */
  exitOnSignal: NodeJS.Signals | null = null;

  constructor(options: { readonly pid?: number | undefined } = {}) {
    super();
    this.pid = 'pid' in options ? options.pid : 4321;
  }

  get stdio(): [Writable, Readable, Readable, Readable | Writable | null | undefined, Readable | Writable | null | undefined] {
    return [this.stdin, this.stdout, this.stderr, null, null];
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const delivered = signal ?? 'SIGTERM';
    this.killSignals.push(delivered);
    if (this.exitOnSignal !== null) {
      if (delivered === this.exitOnSignal) {
        this.killed = true;
        this.signalCode = this.exitOnSignal;
        queueMicrotask(() => { this.exitCode = 1; this.emit('close', 1, null); });
      }
      return true;
    }
    if (this.killFails) return false;
    this.killed = true;
    if (typeof delivered === 'string') this.signalCode = delivered;
    this.emit('close', null, this.signalCode);
    return true;
  }

  /** Ends the process with an exit code, as a clean exit does. */
  close(code = 0): void {
    this.exitCode = code;
    this.signalCode = null;
    this.emit('close', code, null);
  }

  /** Reports a spawn or runtime failure, then closes, as Node does. */
  fail(error: Error, code: number | null = 1): void {
    this.emit('error', error);
    this.exitCode = code;
    this.emit('close', code, null);
  }

  send(): boolean { return false; }
  disconnect(): void { /* the test child has no IPC channel */ }
  unref(): void { /* the test child never holds the loop open */ }
  ref(): void { /* the test child never holds the loop open */ }
  [Symbol.dispose](): void { this.kill(); }
}
