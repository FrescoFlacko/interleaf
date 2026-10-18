import type { SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * The part of a spawned process this runner drives: the two output pipes it
 * reads, the identity it needs to signal a process group, the kill it
 * escalates through, and the two endings it waits for. A Node `ChildProcess`
 * answers this, and so does a scripted child in a boundary test, so neither
 * side depends on the rest of Node's child-process surface. The pipes are
 * nullable exactly as Node's are, because a helper command is spawned with its
 * stdio ignored.
 */
export type RunnerChildProcess = {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

/** How this runner starts a process: fixed file, argv array, no shell. */
export type ProcessSpawner = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => RunnerChildProcess;
