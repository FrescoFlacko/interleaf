import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, type AppHandle, type LaunchRecord } from './helpers';
import { expectHandoffToNewOwner, startCompletedAgentSession } from './agent-session-handoff';
import { closeThenRemoveOwned, runBody, settleOwnedRun } from './owned-run-cleanup';

/**
 * The agent session ownership handoff across a quit and relaunch with the same
 * userData. Every host reaches this (on Linux and Windows closing the last
 * window quits the app, so it is the only way a different window meets an
 * earlier session); macOS additionally keeps the app alive across a window
 * close, which `platform/macos/agent-window-close-reopen.spec.ts` covers. The
 * relaunched window recovers the session from disk and, like the reopened
 * macOS window, is barred until it claims it, then copies, reviews, resumes and
 * applies it.
 */
test.describe('Agent session handoff across a quit and relaunch', () => {
  test('bars the relaunched window until it claims the recovered session, then reviews, copies, resumes and applies it', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-relaunch-'));
    let app: AppHandle | undefined;
    // The latest launch's record. It reaches this test before that launch can
    // fail and holds the app it started even if the launch then rejects, so a
    // missing handle never reads as a closed app.
    let launch: LaunchRecord | undefined;
    const onLaunch = (record: LaunchRecord): void => { launch = record; };
    // The first launch creates this profile; the relaunch is handed it as the
    // caller's, so neither close removes it. This test owns it, and removes it
    // only once the app using it has closed or positively exited; whatever the
    // body threw is rethrown unchanged after the cleanup is annotated.
    let ownedProfile: string | undefined;
    const body = await runBody(async () => {
      app = await launchInterleaf({ testSeam: true, onLaunch });
      ownedProfile = app.userDataDir;
      const completed = await startCompletedAgentSession(app, workingDirectory);

      await app.close({ preserveUserData: true });
      app = undefined;
      app = await launchInterleaf({ userDataDir: ownedProfile, testSeam: true, onLaunch });

      await expectHandoffToNewOwner(app.window, completed, workingDirectory);
    });
    const open = app;
    const last = launch;
    const cleanup = await closeThenRemoveOwned({
      // The handle closes its app and what its launch created; without one, the
      // record closes the app its launch started. A launch that started none
      // has nothing that counts as closed, so that stays unproven.
      close: async () => {
        if (open !== undefined) await open.close();
        else if (last !== undefined) await last.closeProcess();
        else throw new Error('No launch was recorded: there is no app to close and no process to prove exited.');
      },
      // The process taken when the app started: only an exit code or signal there is proof.
      hasExited: () => {
        const child = last?.child ?? null;
        return child !== null && (child.exitCode !== null || child.signalCode !== null);
      },
      owned: [...new Set([...(last?.createdPaths ?? []), ...(ownedProfile === undefined ? [] : [ownedProfile]), workingDirectory])],
      remove: (path) => { rmSync(path, { recursive: true, force: true }); },
    });
    testInfo.annotations.push({ type: 'owned-cleanup', description: settleOwnedRun.describe(cleanup) });
    settleOwnedRun(body, cleanup);
  });
});
