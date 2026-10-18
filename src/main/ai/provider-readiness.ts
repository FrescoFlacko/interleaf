import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';

/** A status younger than this is answered without probing at all. */
const PROVIDER_READINESS_FRESH_MS = 60_000;
/**
 * A status older than the fresh window but younger than this is answered at
 * once while one background probe replaces it. Past it, a read waits for a new
 * probe. Matches the agent runtime's model-catalog lifetime, the other
 * main-owned answer about the same installed CLIs.
 */
const PROVIDER_READINESS_MAX_AGE_MS = 30 * 60_000;

export type ProviderProbe = (
  providerId: AIProviderId,
  options: { readonly forceRefresh?: boolean } | undefined,
) => Promise<AIProviderStatus>;

type Entry = { readonly status: AIProviderStatus; readonly checkedAt: number };
type Flight = { readonly generation: number; readonly promise: Promise<AIProviderStatus> };
type Slot = { generation: number; entry: Entry | null; flight: Flight | null };

/**
 * Main-owned, app-wide readiness for the providers whose detection is slow.
 *
 * Holds only what a probe already returned — never a credential, never a
 * status nobody probed — and only in memory. Every probe for a provider is
 * numbered by a generation: an invalidation, a recorded status or a forced read
 * starts a new one, and a probe from an older generation can neither be joined
 * nor cached, so a slow answer cannot overwrite a newer truth.
 *
 * This is the read side only. Sending a turn still runs the provider's own
 * fresh detection, which stays the authority on whether that turn may start.
 */
export class ProviderReadiness {
  readonly #probe: ProviderProbe;
  readonly #cached: ReadonlySet<AIProviderId>;
  readonly #freshMs: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #slots = new Map<AIProviderId, Slot>();
  #closed = false;

  constructor(input: {
    readonly probe: ProviderProbe;
    /** Providers whose status is cached; every other id is probed on each read. */
    readonly cachedProviderIds: Iterable<AIProviderId>;
    readonly freshMs?: number;
    readonly maxAgeMs?: number;
    readonly now?: () => number;
  }) {
    this.#probe = input.probe;
    this.#cached = new Set(input.cachedProviderIds);
    this.#freshMs = input.freshMs ?? PROVIDER_READINESS_FRESH_MS;
    this.#maxAgeMs = input.maxAgeMs ?? PROVIDER_READINESS_MAX_AGE_MS;
    this.#now = input.now ?? Date.now;
  }

  /**
   * The provider's readiness. `forceRefresh` always starts a probe of its own:
   * one already running may have begun before whatever the caller is checking
   * for, so it is neither joined nor allowed to cache afterwards.
   */
  status(providerId: AIProviderId, options?: { readonly forceRefresh?: boolean }): Promise<AIProviderStatus> {
    if (this.#closed || !this.#cached.has(providerId)) return this.#probe(providerId, options);
    const slot = this.#slot(providerId);
    if (options?.forceRefresh === true) {
      slot.generation += 1;
      return this.#start(providerId, slot, options);
    }
    const entry = slot.entry;
    const age = entry === null ? Number.POSITIVE_INFINITY : this.#now() - entry.checkedAt;
    if (entry !== null && age >= 0 && age < this.#freshMs) return Promise.resolve(entry.status);
    if (entry !== null && age >= 0 && age < this.#maxAgeMs) {
      this.#current(providerId, slot).catch(() => undefined);
      return Promise.resolve(entry.status);
    }
    return this.#current(providerId, slot);
  }

  /** Starts discovery for every cached provider that has no current answer. */
  prewarm(): void {
    for (const providerId of this.#cached) this.status(providerId).catch(() => undefined);
  }

  /** Forgets a provider's answer; the next read probes again. */
  invalidate(providerId: AIProviderId): void {
    const slot = this.#slots.get(providerId);
    if (slot === undefined) return;
    slot.generation += 1;
    slot.entry = null;
    slot.flight = null;
  }

  /** Adopts a status a main-owned action has just probed, such as a finished sign-in. */
  record(status: AIProviderStatus): void {
    if (this.#closed || !this.#cached.has(status.id)) return;
    const slot = this.#slot(status.id);
    slot.generation += 1;
    slot.entry = { status, checkedAt: this.#now() };
    slot.flight = null;
  }

  /** Stops caching; every later read goes straight to the provider. */
  shutdown(): void {
    this.#closed = true;
    this.#slots.clear();
  }

  #slot(providerId: AIProviderId): Slot {
    let slot = this.#slots.get(providerId);
    if (slot === undefined) {
      slot = { generation: 0, entry: null, flight: null };
      this.#slots.set(providerId, slot);
    }
    return slot;
  }

  /** Joins this generation's probe, or starts it. */
  #current(providerId: AIProviderId, slot: Slot): Promise<AIProviderStatus> {
    const flight = slot.flight;
    if (flight !== null && flight.generation === slot.generation) return flight.promise;
    return this.#start(providerId, slot, undefined);
  }

  #start(
    providerId: AIProviderId,
    slot: Slot,
    options: { readonly forceRefresh?: boolean } | undefined,
  ): Promise<AIProviderStatus> {
    const generation = slot.generation;
    const checkedAt = this.#now();
    const promise = this.#probe(providerId, options).then((status) => {
      if (!this.#closed && slot.generation === generation) slot.entry = { status, checkedAt };
      return status;
    }).finally(() => {
      if (slot.flight?.promise === promise) slot.flight = null;
    });
    slot.flight = { generation, promise };
    return promise;
  }
}
