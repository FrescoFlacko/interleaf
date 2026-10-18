/**
 * Test-only globals the end-to-end fixtures install in the page they drive.
 *
 * These are written and read inside `page.evaluate`, which runs in the browser:
 * the callback is serialized and nothing from the test process exists there,
 * not even a typing helper. Declaring the markers keeps the page-side contract
 * in one place instead of re-describing a window shape at every probe, and
 * follows the same `declare global` convention the bridge itself uses.
 *
 * Each marker is declared as present because the fixture that reads it installs
 * it first; a probe that runs too early fails loudly at runtime instead of
 * silently reading `undefined`.
 */

/** One chat stream event, as the page records it for later assertions. */
type RecordedStreamEvent = {
  readonly type: string;
  readonly token?: string;
  readonly requestId: string;
  readonly sessionId: string;
};

/** One agent event, as the page records it for later assertions. */
type RecordedAgentEvent = {
  readonly type: string;
  readonly ordinal: number;
};

declare global {
  /** The subset of axe-core's contract the accessibility probes use. */
  type AxeRunner = {
    run(
      target: string,
      options: { readonly runOnly: { readonly type: string; readonly values: readonly string[] } }
    ): Promise<{ readonly violations: readonly AxeRunViolation[] }>;
  };

  /** One accessibility violation, as the probes report it to the test process. */
  type AxeRunViolation = { readonly id: string; readonly nodes: readonly AxeRunNode[] };

  /** One offending node of a violation, identified by its selector chain. */
  type AxeRunNode = { readonly target: readonly string[] };

  /** Stream events captured through the chat push bridge. */
  var __streamEvents: RecordedStreamEvent[];
  /** Agent events captured through the agent push bridge. */
  var __agentEvents: RecordedAgentEvent[];
  /** axe-core, evaluated into the page by the accessibility fixtures. */
  var axe: AxeRunner;
  /**
   * The capture-phase `selectionchange` listener the defect-9 baseline installs
   * to reproduce the pre-fix behaviour, kept on the window so the same spec can
   * remove it again before exercising the fixed flow. Optional: it is absent
   * until the baseline step installs it, and again after removal.
   */
  var __defect9_baseline_blocker: ((event: Event) => void) | undefined;
}

export {};
