import type { z } from 'zod';
import type {
  createCustomAgentProfileRequestSchema,
  customAgentEnvironmentOverrideSchema,
  customAgentProfileSchema,
  customAgentWorkingDirectoryPolicySchema,
  executableSelectionSchema,
  updateCustomAgentProfileRequestSchema,
} from '../schemas/custom-agent-profile';

export type CustomAgentWorkingDirectoryPolicy = z.output<typeof customAgentWorkingDirectoryPolicySchema>;

/**
 * This is the only executable information that may cross the preload bridge.
 * The canonical path, stat identity, and file contents remain main-owned.
 */
export type AgentExecutableSelection = z.output<typeof executableSelectionSchema>;
export type CustomAgentEnvironmentOverride = z.output<typeof customAgentEnvironmentOverrideSchema>;
export type CustomAgentProfile = z.output<typeof customAgentProfileSchema>;
export type CustomAgentProfileCreateInput = z.input<typeof createCustomAgentProfileRequestSchema>;
export type CustomAgentProfileUpdateInput = z.input<typeof updateCustomAgentProfileRequestSchema>;
