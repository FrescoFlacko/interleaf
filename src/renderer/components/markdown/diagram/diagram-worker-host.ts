import PeleRenderWorker from './pele-render.worker?worker';
import { createDiagramRenderQueue, type DiagramRenderQueue } from './diagram-render-queue';

let queue: DiagramRenderQueue | null = null;

/**
 * The renderer's one diagram queue, created on first use. Pele is bundled into
 * the worker chunk and loads from the app itself, so rendering never touches
 * the network.
 */
export function diagramRenderQueue(): DiagramRenderQueue {
  queue ??= createDiagramRenderQueue(() => new PeleRenderWorker());
  return queue;
}
