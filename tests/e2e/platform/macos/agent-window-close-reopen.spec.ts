import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissOnboardingIfOpen, launchInterleaf, type AppHandle } from '../../helpers';
import { expectHandoffToNewOwner, startCompletedAgentSession } from '../../agent-session-handoff';
import { MACOS_NATIVE_DEFERRED, macosNativeDeferred, requireNativeHost } from '../native-host';

/**
 * macOS close/reopen ownership handoff (docs/REMAINING_WORK.md item C).
 *
 * Closing the last window on macOS keeps the app — and the agent service —
 * alive (`src/main/index.ts` quits on `window-all-closed` everywhere else), so
 * the window that reopens is a different owner in the same process. It must be
 * barred from the earlier window's session until it claims it explicitly, and
 * then be able to review, copy and resume it. The same handoff across a quit
 * and relaunch, which every host can reach, is
 * `tests/e2e/agent-session-relaunch-handoff.spec.ts`.
 */
test.describe('Agent session handoff across a macOS window close and reopen', () => {
  test.skip(macosNativeDeferred(), MACOS_NATIVE_DEFERRED);
  let app: AppHandle;

  test.beforeAll(() => {
    requireNativeHost('darwin');
  });

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
    await dismissOnboardingIfOpen(app);
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('bars the reopened window until it claims the session, then reviews, copies, resumes and applies it', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-reopen-'));
    try {
      const completed = await startCompletedAgentSession(app, workingDirectory);

      // The owning window is closed. On macOS the app, and the agent service
      // with it, stay alive.
      await app.electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.close();
      });
      await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);

      const reopened = app.electronApp.waitForEvent('window');
      await app.electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
      const window2 = await reopened;
      await window2.waitForLoadState('domcontentloaded');

      await expectHandoffToNewOwner(window2, completed, workingDirectory);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
