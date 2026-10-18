import { useOpenFileStore } from "../stores/use-open-file-store";
import { AppIcon } from "./AppIcon";

/**
 * Reports a file that could not be opened. It sits in the shell rather than
 * the library, because a refused file leaves whatever was being read on screen.
 */
export function OpenFileNotice() {
  const error = useOpenFileStore((state) => state.error);
  const dismissError = useOpenFileStore((state) => state.dismissError);
  if (error === null) return null;
  return (
    <div
      data-testid="open-file-error"
      role="alert"
      className="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-6 py-2 text-xs text-danger"
    >
      <span>{error}</span>
      <button
        type="button"
        aria-label="Dismiss error"
        onClick={dismissError}
        className="ml-4 font-bold hover:opacity-75"
      >
        <AppIcon name="close" size={14} />
      </button>
    </div>
  );
}
