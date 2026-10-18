import type { z } from 'zod';
import type { ResolvedAgentExecutionMode } from '../constants/agent-modes';
import type {
  agentEnvironmentReviewSchema,
  agentRiskGrantRequestSchema,
  agentRiskGrantSchema,
  environmentChangeSchema,
  environmentTestResultSchema,
} from '../schemas/agent-environment';

export type EnvironmentFileChange = z.output<typeof environmentChangeSchema>;
export type EnvironmentChangeKind = EnvironmentFileChange['kind'];
export type EnvironmentTestResult = z.output<typeof environmentTestResultSchema>;
export type AgentEnvironmentReview = z.output<typeof agentEnvironmentReviewSchema>;

export type AgentSessionEnvironment = AgentEnvironmentReview & {
  readonly sessionId: string;
};

/** Renderer-safe review DTO. It intentionally contains no canonical paths. */
export type AgentEnvironmentReviewResult = {
  readonly sessionId: string;
  readonly review: AgentEnvironmentReview;
};

export type AgentRiskGrantRequest = z.output<typeof agentRiskGrantRequestSchema>;
export type AgentRiskGrant = z.output<typeof agentRiskGrantSchema>;

type AgentPatchExport = {
  readonly artifactId: string;
  readonly fileName: string;
  readonly bytes: number;
};

/**
 * Closing the save dialog is the reader's choice, not a failure: it is a typed
 * outcome, so no layer has to recognise it from an error message.
 */
export type AgentPatchExportResult =
  | ({ readonly outcome: 'exported' } & AgentPatchExport)
  | { readonly outcome: 'cancelled' };

export type AgentOpenFolderResult = {
  readonly opened: boolean;
};

export type AgentModeAvailability = {
  readonly mode: ResolvedAgentExecutionMode | 'auto-isolated';
  readonly available: boolean;
  readonly reason: string | null;
  readonly containerRuntime: 'docker' | 'podman' | null;
};
