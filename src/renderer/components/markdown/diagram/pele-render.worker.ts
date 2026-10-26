import type { DedicatedWorkerScope } from '../../../features/reader/adapters/worker-scope';
import type { DiagramRenderRequest, DiagramRenderResponse } from './diagram-protocol';
import { renderDiagramSource } from './pele-render-core';

/**
 * Renders AI-output diagrams off the UI thread. The host owns this worker and
 * terminates it on a timeout or when the request it is running is cancelled.
 */
const workerScope: DedicatedWorkerScope<DiagramRenderRequest, DiagramRenderResponse> = globalThis;
workerScope.onmessage = (event): void => {
  const { id, source } = event.data;
  if (typeof id !== 'number' || typeof source !== 'string') return;
  workerScope.postMessage(renderDiagramSource({ id, source }));
};
