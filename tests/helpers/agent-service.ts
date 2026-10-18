import { basename, join, resolve } from 'node:path';
import { AgentRegistry } from '../../src/main/agents/agent-adapter';
import { AgentService, type AgentServiceOptions } from '../../src/main/agents/agent-service';
import { AgentEnvironmentManager } from '../../src/main/agents/environment-manager';
import { ExecutableRegistry } from '../../src/main/agents/executable-registry';
import type { InterleafDatabase } from '../../src/main/db/database';
import { CustomAgentProfileRepository } from '../../src/main/db/repositories/custom-agent-profile-repository';
import { environmentShell, testAgentRegistryOptions } from './agent-collaborators';

type Defaulted =
  | 'agentRegistry'
  | 'allowFakeAgent'
  | 'environmentManager'
  | 'confirmDirectWorkspace'
  | 'customProfiles'
  | 'executableRegistry'
  | 'chooseExecutable'
  | 'confirmUnsafeCustomProfile'
  | 'confirmExpertShellProfile'
  | 'confirmDangerousAgentRun'
  | 'clipboard';

export type TestAgentServiceOptions = Omit<AgentServiceOptions, Defaulted> &
  Partial<Pick<AgentServiceOptions, Defaulted>> & {
    /** The database the service's repositories share. */
    readonly database: InterleafDatabase;
  };

/**
 * Complete `AgentService` options with production's collaborators, so a test
 * overrides only the seams it exercises.
 *
 * Every native confirmation answers as a user who declines and the executable
 * picker as one who cancels, which is what production's dialogs return when
 * nobody accepts them. The fake agent is enabled, as the unpackaged test
 * bootstrap enables it, and one `ExecutableRegistry` is shared by the service
 * and its registry exactly as `src/main/index.ts` shares it.
 */
function testAgentServiceOptions(options: TestAgentServiceOptions): AgentServiceOptions {
  const { database, ...rest } = options;
  const executableRegistry = rest.executableRegistry ?? new ExecutableRegistry();
  const contextParent = basename(resolve(rest.contextRoot, '..'));
  return {
    agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry, logger: rest.log })),
    allowFakeAgent: true,
    environmentManager: new AgentEnvironmentManager({
      root: join(rest.contextRoot, '..', '..', 'environments', contextParent),
      ...environmentShell,
    }),
    confirmDirectWorkspace: () => Promise.resolve(false),
    customProfiles: new CustomAgentProfileRepository(database),
    chooseExecutable: () => Promise.resolve(null),
    confirmUnsafeCustomProfile: () => Promise.resolve(false),
    confirmExpertShellProfile: () => Promise.resolve(false),
    confirmDangerousAgentRun: () => Promise.resolve(false),
    clipboard: { writeText: () => Promise.resolve() },
    ...rest,
    executableRegistry,
  };
}

export function createTestAgentService(options: TestAgentServiceOptions): AgentService {
  return new AgentService(testAgentServiceOptions(options));
}
