import { bridge } from '../app/api-client';
import { isProviderReady } from './chat-provider-readiness';
import { documentLoadStillCurrent, type ChatRuntime } from './chat-runtime';
import { ensureSessionForDocument } from './chat-session-actions';
import { selectActiveDocument, useReaderStore } from './use-reader-store';

/**
 * Orders provider probes. Each probe takes a number when it is issued and only
 * the newest may publish, so an older answer arriving late cannot rebind the
 * picker to readiness a newer probe has already replaced.
 */
export class ProviderDiscovery {
  #requestSequence = 0;

  begin(): number {
    this.#requestSequence += 1;
    return this.#requestSequence;
  }

  isCurrent(requestSeq: number): boolean {
    return requestSeq === this.#requestSequence;
  }

  /** Abandons whatever probe is in flight. */
  invalidate(): void {
    this.#requestSequence += 1;
  }
}

/**
 * Reads provider readiness for a document load and publishes it by itself.
 *
 * A newer refresh may have observed a more current status while this probe was
 * still running, so an out-of-order answer is dropped rather than allowed to
 * rebind the picker to stale readiness. Success and failure are different
 * outcomes and are recorded as such: a failed probe leaves readiness unknown,
 * which is not the same claim as an authoritative list with nothing ready in
 * it. It never touches the persisted conversation: a provider that cannot be
 * probed does not make stored messages unreadable.
 */
export async function loadDocumentProviders(
  runtime: ChatRuntime,
  documentId: string,
  documentSeq: number,
  requestSeq: number
): Promise<void> {
  const stillCurrent = (): boolean =>
    documentLoadStillCurrent(runtime, documentSeq, documentId) && runtime.discovery.isCurrent(requestSeq);
  try {
    const providers = await bridge.ai.listProviders();
    if (!stillCurrent()) return;
    runtime.set({ providers, providerDiscovery: 'succeeded' });
  } catch {
    if (!stillCurrent()) return;
    runtime.set({ providerDiscovery: 'failed' });
  }
}

/**
 * Re-reads provider readiness for the open panel. `forceRefresh` is for an
 * explicit user check such as *Check again*, which must probe rather than
 * accept main's cached answer.
 */
export async function refreshProviders(
  runtime: ChatRuntime,
  options?: { readonly forceRefresh?: boolean }
): Promise<void> {
  // Announce the re-read before awaiting anything: the settings that decide
  // the effective model are already saved by the time this is called, so any
  // view holding a figure from the old binding is stale from this moment on,
  // whether or not the provider list itself comes back or changes.
  runtime.set((state) => ({
    providerBindingRevision: state.providerBindingRevision + 1,
    // The saved change may have removed the very provider a turn would use,
    // so the previous answer stops being current here, not when the new one
    // arrives. Actions fail closed for as long as this re-read is running.
    providerDiscovery: 'loading' as const,
  }));
  const requestSequence = runtime.discovery.begin();
  try {
    const providers = await bridge.ai.listProviders(options);
    if (!runtime.discovery.isCurrent(requestSequence)) return;
    runtime.set({ providers, providerDiscovery: 'succeeded' });
    // If we are idle, have a document open, but had no active session because no provider was ready before:
    const state = runtime.get();
    if (
      !state.isStreaming &&
      state.activeDocument &&
      !state.activeSessionId &&
      providers.some(isProviderReady)
    ) {
      const firstDoc = selectActiveDocument(useReaderStore.getState());
      if (firstDoc?.id === state.activeDocument.id) {
        void ensureSessionForDocument(runtime, firstDoc);
      }
    }
  } catch {
    // The probe ran and could not answer. Saying so leaves the panel a state
    // it can report and retry from; keeping the previous list marked current
    // would let a provider that was ready before this failure authorize a
    // turn it was never asked about.
    if (runtime.discovery.isCurrent(requestSequence)) runtime.set({ providerDiscovery: 'failed' });
  }
}
