import { Component } from "react";

/**
 * A synchronous "the layout is about to change" signal, raised before React
 * mutates the DOM for a commit that resizes the reader (a side panel's width
 * or open state). Subscribers read the old layout while it still holds: the
 * reader records the block under the top of its viewport here, so a scroll
 * made in the same task as the resize is never lost to the re-wrap.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeLayoutWillChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announceLayoutWillChange(): void {
  for (const listener of [...listeners]) listener();
}

type SignalProps = {
  /** Any value that changes exactly when the caller's layout will change. */
  readonly layoutKey: string;
};

/**
 * Raises the signal from `getSnapshotBeforeUpdate`, the one React phase that
 * runs after rendering and before any DOM mutation of the commit, whatever
 * caused the update (a key press, a drag frame, a toggle elsewhere in the app).
 * Renders nothing.
 */
export class LayoutWillChangeSignal extends Component<SignalProps> {
  override getSnapshotBeforeUpdate(previous: SignalProps): null {
    if (previous.layoutKey !== this.props.layoutKey) announceLayoutWillChange();
    return null;
  }

  override componentDidUpdate(): void {
    // React requires the companion of `getSnapshotBeforeUpdate`; nothing to do here.
  }

  override render(): null {
    return null;
  }
}
