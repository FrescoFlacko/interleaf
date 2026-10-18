import { existsSync } from 'node:fs';

/**
 * Wait until a child process reports readiness by creating a marker file.
 *
 * A fixture that must be acted on *while it runs* — a hanging capability probe,
 * for instance — cannot be timed with a guessed startup delay without racing
 * process boot. The fixture writes the marker once it is genuinely running and
 * the test waits for it here, bounded so a fixture that never starts fails the
 * test instead of hanging it.
 */
export async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`fixture never reported readiness: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
