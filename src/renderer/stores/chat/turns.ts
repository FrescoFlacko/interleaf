import type { ChatStreamEvent } from '@shared/types/ai';

/** A stream event that ends the turn it belongs to. */
export type TerminalStreamEvent = Extract<ChatStreamEvent, { type: 'done' | 'error' }>;

/** How a turn ended, from this renderer's point of view. */
type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';

/**
 * Where the composer's current turn stands. `turn` numbers every send and every
 * navigation that invalidates one, so a continuation holding an older number
 * knows it no longer owns the conversation.
 *
 * - `preparing`: the send has claimed the composer and is attaching context and
 *   re-checking readiness; nothing has crossed the bridge yet.
 * - `awaiting-ack`: the `sendMessage` invoke is unresolved. Main may already
 *   stream; a token reveals the request id, and terminal events are held until
 *   the invoke supplies the turn's canonical messages and submitted prompt.
 * - `streaming`: the invoke resolved and the request id is authoritative.
 * - `settled`: the turn is over, however it ended.
 */
export type TurnPhase =
  | { readonly kind: 'idle'; readonly turn: number }
  | { readonly kind: 'preparing'; readonly turn: number; readonly sessionId: string }
  | {
      readonly kind: 'awaiting-ack';
      readonly turn: number;
      readonly sessionId: string;
      readonly revealedRequestId: string | null;
      readonly earlyTerminals: ReadonlyMap<string, TerminalStreamEvent>;
    }
  | { readonly kind: 'streaming'; readonly turn: number; readonly sessionId: string; readonly requestId: string }
  | { readonly kind: 'settled'; readonly turn: number; readonly outcome: TurnOutcome };

/** Everything that can move a turn. */
export type TurnEvent =
  | { readonly type: 'begin'; readonly sessionId: string }
  | { readonly type: 'dispatch'; readonly turn: number }
  | { readonly type: 'reveal'; readonly requestId: string }
  | { readonly type: 'buffer-terminal'; readonly event: TerminalStreamEvent }
  | { readonly type: 'acknowledge'; readonly turn: number; readonly requestId: string }
  | { readonly type: 'settle'; readonly turn: number; readonly outcome: TurnOutcome }
  | { readonly type: 'supersede' };

/** What the store does with one stream event, given the current phase. */
export type StreamRoute = 'ignore' | 'token' | 'buffer' | 'terminal';

/** The store fields every phase publishes. */
export type TurnProjection = { readonly isStreaming: boolean; readonly activeRequestId: string | null };

const MAX_EARLY_TERMINALS = 64;
const MAX_SETTLED_REQUESTS = 256;

function assertNever(value: never): never {
  throw new Error(`Unhandled turn value: ${JSON.stringify(value)}`);
}

function beginTurn(phase: TurnPhase, sessionId: string): TurnPhase {
  return { kind: 'preparing', turn: phase.turn + 1, sessionId };
}

function dispatchTurn(phase: TurnPhase, turn: number): TurnPhase {
  if (phase.kind !== 'preparing' || phase.turn !== turn) return phase;
  return { kind: 'awaiting-ack', turn, sessionId: phase.sessionId, revealedRequestId: null, earlyTerminals: new Map() };
}

function revealRequest(phase: TurnPhase, requestId: string): TurnPhase {
  if (phase.kind !== 'awaiting-ack' || phase.revealedRequestId !== null) return phase;
  return { ...phase, revealedRequestId: requestId };
}

function bufferTerminal(phase: TurnPhase, event: TerminalStreamEvent): TurnPhase {
  if (phase.kind !== 'awaiting-ack') return phase;
  const earlyTerminals = new Map(phase.earlyTerminals);
  earlyTerminals.set(event.requestId, event);
  const oldest = earlyTerminals.keys().next().value;
  if (earlyTerminals.size > MAX_EARLY_TERMINALS && oldest !== undefined) earlyTerminals.delete(oldest);
  return { ...phase, earlyTerminals };
}

function acknowledgeTurn(phase: TurnPhase, turn: number, requestId: string): TurnPhase {
  if (phase.kind !== 'awaiting-ack' || phase.turn !== turn) return phase;
  return { kind: 'streaming', turn, sessionId: phase.sessionId, requestId };
}

function settleTurn(phase: TurnPhase, turn: number, outcome: TurnOutcome): TurnPhase {
  if (phase.kind === 'idle' || phase.turn !== turn) return phase;
  return { kind: 'settled', turn, outcome };
}

/**
 * The one place a turn changes phase. An event that does not apply to the
 * current phase — an acknowledgement for a turn already superseded, say —
 * leaves it unchanged.
 */
function transitionTurn(phase: TurnPhase, event: TurnEvent): TurnPhase {
  switch (event.type) {
    case 'begin':
      return beginTurn(phase, event.sessionId);
    case 'dispatch':
      return dispatchTurn(phase, event.turn);
    case 'reveal':
      return revealRequest(phase, event.requestId);
    case 'buffer-terminal':
      return bufferTerminal(phase, event.event);
    case 'acknowledge':
      return acknowledgeTurn(phase, event.turn, event.requestId);
    case 'settle':
      return settleTurn(phase, event.turn, event.outcome);
    case 'supersede':
      return { kind: 'settled', turn: phase.turn + 1, outcome: 'superseded' };
    default:
      return assertNever(event);
  }
}

/** Whether the composer is busy and which request it follows, for each phase. */
export function turnProjection(phase: TurnPhase): TurnProjection {
  switch (phase.kind) {
    case 'idle':
    case 'settled':
      return { isStreaming: false, activeRequestId: null };
    case 'preparing':
      return { isStreaming: true, activeRequestId: null };
    case 'awaiting-ack':
      return { isStreaming: true, activeRequestId: phase.revealedRequestId };
    case 'streaming':
      return { isStreaming: true, activeRequestId: phase.requestId };
    default:
      return assertNever(phase);
  }
}

/** Request ids a phase is following, which stop being followed once it settles. */
function followedRequestIds(phase: TurnPhase): readonly string[] {
  if (phase.kind === 'streaming') return [phase.requestId];
  if (phase.kind !== 'awaiting-ack') return [];
  const early = [...phase.earlyTerminals.keys()];
  return phase.revealedRequestId === null ? early : [phase.revealedRequestId, ...early];
}

/**
 * The turn model of one chat controller: the current phase, and the bounded
 * record of request ids whose turns have settled here, so a late event for one
 * of them cannot claim a turn that is still waiting to learn its own id.
 */
export class ChatTurns {
  #phase: TurnPhase = { kind: 'idle', turn: 0 };
  readonly #settledRequests = new Set<string>();

  get phase(): TurnPhase {
    return this.#phase;
  }

  /**
   * Applies one event. Requests the old phase followed and the new one does not
   * — every id of a turn that settles, and the strays buffered beside the one an
   * acknowledgement names — are recorded so a late event cannot revive them.
   */
  apply(event: TurnEvent): TurnPhase {
    const previous = this.#phase;
    const next = transitionTurn(previous, event);
    const stillFollowed = new Set(followedRequestIds(next));
    for (const requestId of followedRequestIds(previous)) {
      if (!stillFollowed.has(requestId)) this.recordSettled(requestId);
    }
    this.#phase = next;
    return next;
  }

  /** Marks a request this renderer will not follow, such as one acknowledged too late. */
  recordSettled(requestId: string): void {
    this.#settledRequests.add(requestId);
    const oldest = this.#settledRequests.values().next().value;
    if (this.#settledRequests.size > MAX_SETTLED_REQUESTS && oldest !== undefined) {
      this.#settledRequests.delete(oldest);
    }
  }

  /** True while no newer send or navigation has replaced this turn. */
  isCurrent(turn: number): boolean {
    return this.#phase.turn === turn;
  }

  /** True when this turn is over and nothing has replaced it. */
  isSettledAt(turn: number): boolean {
    return this.#phase.kind === 'settled' && this.#phase.turn === turn;
  }

  /** What to do with a stream event already matched to the conversation in view. */
  route(event: ChatStreamEvent): StreamRoute {
    const phase = this.#phase;
    switch (phase.kind) {
      case 'idle':
      case 'preparing':
      case 'settled':
        return 'ignore';
      case 'awaiting-ack':
        return this.#routeBeforeAcknowledgement(phase.revealedRequestId, event);
      case 'streaming':
        if (event.requestId !== phase.requestId) return 'ignore';
        return event.type === 'token' ? 'token' : 'terminal';
      default:
        return assertNever(phase);
    }
  }

  /**
   * Before the invoke resolves, the first token is what names the request; any
   * id that already settled here is stale. Terminal events wait for the invoke,
   * which alone carries the messages and prompt they settle against.
   */
  #routeBeforeAcknowledgement(revealedRequestId: string | null, event: ChatStreamEvent): StreamRoute {
    if (revealedRequestId !== null && event.requestId !== revealedRequestId) return 'ignore';
    if (revealedRequestId === null && this.#settledRequests.has(event.requestId)) return 'ignore';
    return event.type === 'token' ? 'token' : 'buffer';
  }
}
