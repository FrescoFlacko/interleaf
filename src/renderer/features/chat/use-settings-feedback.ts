import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** How long a success message stays before it clears itself. */
const SUCCESS_DWELL_MS = 4000;

export type SettingsFeedback = {
  readonly error: string | null;
  readonly successMessage: string | null;
  /** Shows a transient success message, replacing any earlier one. */
  readonly announce: (message: string) => void;
  /** Shows a failure; failures stay until something clears them. */
  readonly fail: (message: string) => void;
  readonly clearError: () => void;
  readonly clearSuccess: () => void;
  /** Clears both messages, as a new user action does before it starts. */
  readonly clear: () => void;
};

/**
 * The dialog's one shared feedback line.
 *
 * Every settings feature reports its own outcome through this channel instead
 * of owning a banner, so the dialog shows one error and one success message at
 * a time. Features never read what another feature reported; they only replace
 * or clear it when they start an action of their own.
 */
export function useSettingsFeedback(): SettingsFeedback {
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDismiss = useCallback((): void => {
    if (dismissTimerRef.current === null) return;
    clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
  }, []);

  const announce = useCallback((message: string): void => {
    cancelDismiss();
    setSuccessMessage(message);
    // Transient by design: success text auto-clears after an accessible dwell
    // (role=status has already announced it). Failures keep separate handling.
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      setSuccessMessage(null);
    }, SUCCESS_DWELL_MS);
  }, [cancelDismiss]);

  const clearSuccess = useCallback((): void => {
    cancelDismiss();
    setSuccessMessage(null);
  }, [cancelDismiss]);

  const clearError = useCallback((): void => { setError(null); }, []);

  const clear = useCallback((): void => {
    clearError();
    clearSuccess();
  }, [clearError, clearSuccess]);

  useEffect(() => cancelDismiss, [cancelDismiss]);

  return useMemo(() => ({
    error,
    successMessage,
    announce,
    fail: setError,
    clearError,
    clearSuccess,
    clear,
  }), [error, successMessage, announce, clearError, clearSuccess, clear]);
}
