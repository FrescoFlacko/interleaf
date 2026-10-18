import { z } from 'zod';
import { agentContextPacketSchema, agentPromptSchema } from './agent';

export const environmentChangeSchema = z.object({
  path: z.string().min(1).max(1_024),
  kind: z.enum(['created', 'modified', 'deleted']),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  bytes: z.number().int().min(0).max(64 * 1024 * 1024),
}).strict();

export const environmentTestResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'skipped', 'unknown']),
  summary: z.string().max(2_000),
  exitCode: z.number().int().min(-255).max(255).nullable(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable(),
}).strict();

export const agentEnvironmentReviewSchema = z.object({
  mode: z.enum(['isolated-worktree', 'isolated-copy', 'native-restricted', 'container-sandbox', 'active-env']),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  workspaceLabel: z.string().min(1).max(512),
  primaryWasDirty: z.boolean(),
  applyAllowed: z.boolean(),
  applyDisabledReason: z.string().max(2_000).nullable(),
  /**
   * True after Apply Changes commits the environment to the primary target.
   * Reviews stored before apply was tracked on the review were not applied.
   */
  applied: z.boolean().default(false),
  activeWorkspaceModified: z.boolean(),
  changedFiles: z.array(environmentChangeSchema).max(10_000),
  tests: z.array(environmentTestResultSchema).max(128),
  diffAvailable: z.boolean(),
  diff: z.string().max(2 * 1024 * 1024).nullable(),
  patchAvailable: z.boolean(),
  containerRuntime: z.enum(['docker', 'podman']).nullable(),
}).strict();

export const agentRiskGrantRequestSchema = z.object({
  draftId: z.string().trim().min(1).max(128),
  profileId: z.string().trim().min(1).max(128),
  workingDirectoryHandle: z.string().trim().min(1).max(128),
  executionMode: z.enum(['active-env', 'native-restricted']),
  prompt: agentPromptSchema,
  model: z.string().trim().max(128).nullable(),
  contextPacket: agentContextPacketSchema.nullable(),
}).strict();

export const agentRiskGrantSchema = z.object({
  grantId: z.uuid(),
  expiresAt: z.number().int().positive(),
  mode: z.enum(['active-env', 'native-restricted']),
}).strict();
