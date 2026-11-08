import { z } from 'zod';
import { IPC } from '@shared/constants/ipc';
import { InterleafError } from '@shared/errors/interleaf-error';
import { aiProviderIdSchema } from '@shared/schemas/ai';
import { practiceCardSchema } from '@shared/schemas/practice';
import type { InterleafAPI } from '@shared/types/api';
import type { PreloadInvoke } from './index';

export function createPracticeBridge(invoke: PreloadInvoke): InterleafAPI['practice'] {
  function parse<T>(schema: z.ZodType<T>, value: z.input<typeof practiceCardSchema> | readonly z.input<typeof practiceCardSchema>[] | null): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new InterleafError('internal', 'The practice response was invalid.');
    return result.data;
  }
  return {
    create: async (input) => parse(practiceCardSchema, await invoke(IPC.practiceCreate, input)),
    createImported: async (input) => parse(practiceCardSchema, await invoke(IPC.practiceCreateImported, input)),
    due: async (limit) => parse(z.array(practiceCardSchema).max(50), await invoke(IPC.practiceDue, { limit })),
    rate: async (input) => parse(practiceCardSchema, await invoke(IPC.practiceRate, input)),
    get: async (cardId) => parse(practiceCardSchema.nullable(), await invoke(IPC.practiceGet, { cardId })),
    check: async (input) => {
      const result = z.string().max(16000).nullable().safeParse(await invoke(IPC.practiceCheck, { ...input, providerId: aiProviderIdSchema.parse(input.providerId) }));
      if (!result.success) throw new InterleafError('internal', 'The practice check response was invalid.');
      return result.data;
    },
    cancelCheck: async () => { await invoke(IPC.practiceCancelCheck); },
  };
}
