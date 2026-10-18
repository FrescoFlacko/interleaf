import type { z } from 'zod';
import type { ResolvedAgentExecutionMode } from '../constants/agent-modes';
import type { PortableRecord } from '../models/portable';
import type { AgentSessionEnvironment } from './agent-environment';
import type {
  agentContextPacketSchema,
  agentCopyResultResponseSchema,
  agentEventSchema,
  agentProfileSchema,
  agentProfileStatusSnapshotSchema,
  agentResumeRequestSchema,
  agentStartRequestSchema,
  agentWorkingDirectorySchema,
} from '../schemas/agent';

/** `fake` is retained only for main-owned deterministic test doubles; it is
 * absent from runtime profile schemas and normal IPC-visible profiles. */
export type AgentProviderId = 'codex' | 'claude-code' | 'antigravity' | 'copilot' | 'opencode' | 'pi' | 'cursor' | 'fake' | 'custom';
export type AgentSessionStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentEnvironmentLifecycle = 'prepared' | 'applied' | 'discarded';

/** Profiles carry `AgentProviderId`, which also admits the test-only `fake` provider. */
export type AgentProfile = Omit<z.output<typeof agentProfileSchema>, 'providerId'> & {
  readonly providerId: AgentProviderId;
};
export type AgentCapabilities = AgentProfile['capabilities'];
export type AgentDetection = AgentProfile['detection'];
export type AgentAvailability = AgentDetection['availability'];

/**
 * One agent row's settled detection state, as onboarding renders it.
 *
 * A projection of the same main-owned profile record `agent:list-profiles`
 * returns — no executable path, no raw probe output, no new capability. It
 * exists because the full profile list awaits background model discovery before
 * it resolves, and a progressive row set needs the detection facts that are
 * already known without waiting for catalogs.
 *
 * `unavailability` says why a runtime is unavailable, when it is: `not-found`
 * when the bounded PATH lookup established absence, `unsupported` for a fixed
 * product decision, `error` when detection itself failed, `none` otherwise.
 * Only `not-found` justifies pointing the user at installation instructions,
 * so the distinction is made in main rather than guessed from an error string.
 */
export type AgentProfileStatusSnapshot = z.output<typeof agentProfileStatusSnapshotSchema>;
export type AgentProfileStatus = AgentProfileStatusSnapshot['profiles'][number];
export type AgentUnavailabilityReason = AgentProfileStatus['unavailability'];

export type AgentWorkingDirectory = z.output<typeof agentWorkingDirectorySchema>;
export type AgentContextPacket = z.output<typeof agentContextPacketSchema>;

/** What a caller sends to start a run; omitted members take their defaults. */
export type AgentRunRequestInput = z.input<typeof agentStartRequestSchema>;
/** A validated start request with every member stated. */
export type AgentRunRequest = z.output<typeof agentStartRequestSchema>;
export type AgentResumeRequest = z.output<typeof agentResumeRequestSchema>;

/**
 * The result of an explicit owner-to-owner session handoff (item C). A window
 * receives this only when main granted it ownership; `ownerChanged` records
 * that the session was taken over from a destroyed window rather than already
 * belonging to the caller.
 */
export type AgentSessionClaimResult = {
  readonly claimed: true;
  readonly ownerChanged: boolean;
};

export type AgentCopyResultResult = z.output<typeof agentCopyResultResponseSchema>;

export type AgentEvent = z.output<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];
/** An event before the repository assigns its ordinal, still discriminated on `type`. */
export type AgentEventDraft = AgentEvent extends infer Event
  ? Event extends AgentEvent ? Omit<Event, 'ordinal'> : never
  : never;

export type AgentArtifact = {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: 'context_packet' | 'diff' | 'changed_files' | 'test_result' | 'log' | 'patch' | 'recovery_backup';
  readonly metadata: PortableRecord;
  readonly createdAt: string;
  readonly expiresAt: string | null;
};

export type AgentSession = {
  readonly id: string;
  readonly documentId: string;
  readonly profileId: string;
  readonly providerId: AgentProviderId;
  readonly targetDirectory: AgentWorkingDirectory;
  readonly executionMode: ResolvedAgentExecutionMode;
  readonly status: AgentSessionStatus;
  readonly providerSessionId: string | null;
  readonly userPrompt: string;
  readonly contextSummary: string | null;
  readonly finalReport: string | null;
  readonly effectiveModel: string | null;
  readonly effectiveReasoningEffort: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  /** Main-computed review state; never contains a host filesystem path. */
  readonly environment: AgentSessionEnvironment | null;
  /** Main-owned lifecycle marker used to fail closed after apply/discard. */
  readonly environmentState?: AgentEnvironmentLifecycle;
};

export type AgentSessionDetail = AgentSession & {
  readonly events: readonly AgentEvent[];
  readonly artifacts: readonly AgentArtifact[];
};

export type AgentStartResult = { readonly session: AgentSession };
