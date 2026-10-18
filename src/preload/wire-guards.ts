import { z } from 'zod';
import { CHAT_WIRE_DISCLOSURES_PER_MESSAGE } from '@shared/constants/chat-wire';
import {
  chatCitationSchema,
  chatContextDisclosureSchema,
  chatMessageSchema,
  chatSessionTitleChangedEventSchema,
  chatStreamEventSchema,
} from '@shared/schemas/chat-wire';
import { agentEventSchema, fitsAgentEventWireBound } from '@shared/schemas/agent';
import type { ChatCitation, ChatContextDisclosure, ChatMessage, ChatSessionTitleChangedEvent, ChatStreamEvent } from '@shared/types/ai';
import type { AgentEvent } from '@shared/types/agent';
import type { CloneableValue } from '@shared/models/portable';

/**
 * Guards for the payloads main pushes to the renderer.
 *
 * Each one is the shared wire schema main validates with before it sends, not
 * a parallel hand-written copy, so a payload main can emit is a payload the
 * bridge accepts. The preload bundle carries Zod (`externalizeDeps: false` in
 * `electron.vite.config.ts`), which the sandboxed loader needs because it cannot
 * resolve dependencies at runtime; the guards therefore cost no extra trust.
 *
 * A guard only narrows: the callback receives the original structured-clone
 * value, never Zod's output. That is sound only if every value the schema
 * accepts already is a `T`, so the schema's *input* type must be assignable to
 * `T`; the compiler rejects a guard whose schema admits anything else (see
 * `tests/unit/wire-guard-types.spec.ts`). A schema that transforms or defaults
 * would make its output differ from what was received, so these wire schemas do
 * neither, and their optional members are exact (`.exactOptional()`): a member
 * present as `undefined` is refused, as the domain types say it must be.
 */

export function guardFor<T>(schema: z.ZodType<CloneableValue, T>): (value: CloneableValue) => value is CloneableValue & T {
  return (value): value is CloneableValue & T => schema.safeParse(value).success;
}

export const isChatCitation = guardFor<ChatCitation>(chatCitationSchema);

export const isChatMessage = guardFor<ChatMessage>(chatMessageSchema);

export const isChatStreamEvent = guardFor<ChatStreamEvent>(chatStreamEventSchema);

export const isChatSessionTitleChanged = guardFor<ChatSessionTitleChangedEvent>(chatSessionTitleChangedEventSchema);

const matchesAgentEventSchema = guardFor<AgentEvent>(agentEventSchema);

/**
 * The whole-event transport bound is checked on the value as received, before
 * the schema walks it; the schema then checks every member bound.
 */
export function isAgentEvent(value: CloneableValue): value is CloneableValue & AgentEvent {
  return fitsAgentEventWireBound(value) && matchesAgentEventSchema(value);
}

/** The `disclosures` member of a chat message, list bounds included. */
export const isChatContextDisclosureList = guardFor<readonly ChatContextDisclosure[]>(
  z.array(chatContextDisclosureSchema).max(CHAT_WIRE_DISCLOSURES_PER_MESSAGE)
);
