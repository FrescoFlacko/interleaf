import { AgentRegistry, type AgentAdapter } from '../../src/main/agents/agent-adapter';

/**
 * A registry a test can seat its own adapter in.
 *
 * Production registration is main-owned and non-public: detection, settings,
 * model refresh and custom profiles are the only things that decide which
 * adapter answers for a profile id. Several runtime tests do need to install an
 * adapter bound to a launcher they control, and this subclass is the whole of
 * that seam — one named method, reachable only by a test that asks for this
 * class by name, with no mutator added to `AgentRegistry` itself.
 */
export class TestAgentRegistry extends AgentRegistry {
  installAdapter(adapter: AgentAdapter): void {
    this.registerAdapter(adapter);
  }
}
