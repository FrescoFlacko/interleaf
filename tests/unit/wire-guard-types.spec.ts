import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentEventSchema } from '@shared/schemas/agent';
import { chatContextDisclosureSchema, chatMessageSchema } from '@shared/schemas/chat-wire';
import type { AgentEvent } from '@shared/types/agent';
import type { ChatContextDisclosure, ChatMessage } from '@shared/types/ai';
import { guardFor } from '../../src/preload/wire-guards';

/**
 * A preload guard narrows the received value to a domain type, so every value
 * its schema accepts must already be that type. These cases are checked by the
 * compiler (`npm run typecheck` compiles this file): each `@ts-expect-error`
 * fails the typecheck if the line beneath it ever starts to compile.
 */

describe('preload guard typing', () => {
  it('only accepts a schema whose accepted values are the narrowed type', () => {
    // @ts-expect-error A string schema cannot vouch for a ChatMessage.
    guardFor<ChatMessage>(z.string());

    // @ts-expect-error A citation is not a whole message.
    guardFor<ChatMessage>(z.object({ sourceId: z.string(), label: z.string() }));

    // @ts-expect-error `.optional()` admits a member present as `undefined`,
    // which an exact-optional domain type does not allow.
    guardFor<ChatContextDisclosure>(chatContextDisclosureSchema.extend({ includedLabel: z.string().optional() }));

    // @ts-expect-error A transform changes the value after it was accepted; the
    // guard forwards the received value, so its input must already be the type.
    guardFor<{ readonly count: number }>(z.object({ count: z.string().transform(Number) }));

    expect(guardFor<ChatMessage>(chatMessageSchema)).toBeTypeOf('function');
    expect(guardFor<AgentEvent>(agentEventSchema)).toBeTypeOf('function');
  });
});
