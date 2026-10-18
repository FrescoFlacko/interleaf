import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRegistryOptions } from '../../src/main/agents/agent-adapter';
import { ExecutableRegistry } from '../../src/main/agents/executable-registry';
import type { EnvironmentManagerOptions } from '../../src/main/agents/environment-manager';
import { silentLogger } from './silent-logger';

let sharedPromptRoot: string | undefined;

/**
 * The canonical POSIX shell binary, for tests that need a real allowlisted
 * shell. `/bin/sh` itself is a symlink on many Linux distributions (to dash)
 * and executable selection rejects symlinks, so tests select what it resolves
 * to; the symlink rule itself is unchanged.
 */
export function posixShell(): string {
  return realpathSync('/bin/sh');
}

/**
 * One app-owned prompt directory per test worker, standing in for the
 * production `<agentContext>/custom-prompts`. It is removed when the worker
 * exits.
 */
function testPromptRoot(): string {
  if (sharedPromptRoot === undefined) {
    const root = mkdtempSync(join(tmpdir(), 'interleaf-test-prompts-'));
    process.once('exit', () => { rmSync(root, { recursive: true, force: true }); });
    sharedPromptRoot = root;
  }
  return sharedPromptRoot;
}

/**
 * Complete registry options with production's collaborators. A test overrides
 * only what it exercises; `modelDiscovery` is `undefined` exactly as under
 * NODE_ENV=test in production.
 */
export function testAgentRegistryOptions(overrides: Partial<AgentRegistryOptions> = {}): AgentRegistryOptions {
  return {
    executableRegistry: new ExecutableRegistry(),
    promptRoot: testPromptRoot(),
    logger: silentLogger,
    modelDiscovery: undefined,
    ...overrides,
  };
}

/** The collaborators a registry hands every adapter it builds. */
export function adapterCollaborators(
  executableRegistry: ExecutableRegistry = new ExecutableRegistry(),
  promptRoot: string = testPromptRoot(),
  logger: AgentRegistryOptions['logger'] = silentLogger,
): readonly [ExecutableRegistry, string, AgentRegistryOptions['logger']] {
  return [executableRegistry, promptRoot, logger];
}

/**
 * The native shell actions production wires into the environment manager,
 * answering as a user who confirms them. Tests that observe the patch or the
 * folder override the member they inspect.
 */
export const environmentShell: Pick<EnvironmentManagerOptions, 'openFolder' | 'savePatch'> = {
  openFolder: () => Promise.resolve(true),
  savePatch: () => Promise.resolve(true),
};

/** Complete environment-manager options: production's shell actions plus the test's own. */
export function withEnvironmentShell(
  options: Omit<EnvironmentManagerOptions, 'openFolder' | 'savePatch'> & Partial<Pick<EnvironmentManagerOptions, 'openFolder' | 'savePatch'>>,
): EnvironmentManagerOptions {
  return { ...environmentShell, ...options };
}
