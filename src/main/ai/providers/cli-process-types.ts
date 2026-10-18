import type { Stats } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { BoundedExecFileOptions, PipedSpawnOptions } from '../../agents/process-runner';

export type CliSpawnOptions = PipedSpawnOptions;

/**
 * The part of a spawned CLI this provider drives: its three pipes, the identity
 * it needs to signal a process group, how it exited, and the two endings it
 * waits for. A Node `ChildProcessWithoutNullStreams` answers this, and so does
 * a scripted child in a boundary test, so neither side depends on the rest of
 * Node's child-process surface.
 */
export type CliChildProcess = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
};

export type CliProcessSpawner = (
  binary: string,
  args: readonly string[],
  options: CliSpawnOptions,
) => CliChildProcess;
export type CliProcessTerminator = (child: CliChildProcess) => Promise<void>;
export type CliExecFile = (
  binary: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type BinaryResolutionFs = {
  readonly access: (path: string, mode?: number) => Promise<void>;
  readonly lstat: (path: string) => Promise<Pick<Stats, 'isFile' | 'isSymbolicLink'>>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<Pick<Stats, 'isFile'>>;
};
