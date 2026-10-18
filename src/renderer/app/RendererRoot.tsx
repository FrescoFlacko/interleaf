import { App } from "./App";

type RendererRootProps = {
  /** Whether preload installed the bridge; checked once by `main.tsx`. */
  readonly bridgeInstalled: boolean;
};

/**
 * Mounts the app only when the preload bridge is present. Served outside the
 * desktop app (for example `npm run dev:renderer` in a plain browser) there is
 * no main process to talk to, so the renderer shows one static message instead
 * of mounting anything that would call the bridge.
 */
export function RendererRoot({ bridgeInstalled }: RendererRootProps) {
  if (bridgeInstalled) return <App />;
  return (
    <main role="alert" className="flex h-screen items-center justify-center p-8 text-center">
      <p>Interleaf must be opened from the desktop app.</p>
    </main>
  );
}
