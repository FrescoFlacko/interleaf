import type { AgentEvent } from '../../src/shared/types/agent';

/** The serialized error an `error` event carries; `undefined` for every other type. */
export function eventError(event: AgentEvent | undefined): Extract<AgentEvent, { type: 'error' }>['error'] | undefined {
  return event?.type === 'error' ? event.error : undefined;
}
