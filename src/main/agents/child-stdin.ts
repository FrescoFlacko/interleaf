import type { Writable } from 'node:stream';

/**
 * Deliver a bounded stdin payload to an already-spawned child.
 *
 * Two stdin lifetimes exist in the agent runtime and both go through here so
 * neither the launch path nor a listing probe grows its own variant:
 *
 * - A normal run must see EOF, otherwise a CLI that reads to end of input never
 *   finishes on its own and would only stop through cancellation or shutdown.
 * - A server-style protocol (`codex app-server`, `claude --input-format
 *   stream-json`) answers only while stdin stays open, so a probe holding a
 *   request open keeps the descriptor until its own bounded deadline.
 *
 * The error listener is not optional: a child that exits before the payload is
 * flushed makes the pipe emit `EPIPE`, and an unhandled `error` on a stream
 * would take the main process down rather than fail the one run.
 *
 * The stream is nullable because a child spawned with its stdin ignored has no
 * pipe at all; there is nothing to deliver a payload to in that case.
 */
export function writeChildStdin(
  stdin: Writable | null,
  payload: string | undefined,
  keepOpen: boolean,
): void {
  if (stdin !== null) deliverStdin(stdin, payload, keepOpen);
}

/** Writes the payload to a child that does have a stdin pipe. */
function deliverStdin(stdin: Writable, payload: string | undefined, keepOpen: boolean): void {
  stdin.on('error', () => undefined);
  if (payload !== undefined) stdin.write(payload, 'utf8');
  if (!keepOpen) stdin.end();
}
