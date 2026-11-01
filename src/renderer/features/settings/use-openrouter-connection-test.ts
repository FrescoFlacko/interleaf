import { useCallback, useState } from 'react';
import { bridge } from '../../app/api-client';
import type { SettingsFeedback } from './use-settings-feedback';

type OpenRouterTestResult = { readonly success: boolean; readonly message: string };

export type OpenRouterConnectionTest = {
  readonly testing: boolean;
  readonly result: OpenRouterTestResult | null;
  /** Asks main to test the stored key; the key itself never leaves main. */
  readonly test: () => Promise<void>;
  /** Forgets a result that no longer describes the stored credential. */
  readonly reset: () => void;
};

/** Owns the OpenRouter connection test and the result it shows. */
export function useOpenRouterConnectionTest(feedback: SettingsFeedback): OpenRouterConnectionTest {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<OpenRouterTestResult | null>(null);

  const test = async (): Promise<void> => {
    setTesting(true);
    feedback.clearError();
    setResult(null);
    try {
      const outcome = await bridge.credentials.testOpenRouterConnection();
      setResult({
        success: outcome.success,
        message: outcome.message ?? (outcome.success ? 'Connection verified.' : 'Connection failed.'),
      });
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  const reset = useCallback((): void => { setResult(null); }, []);

  return { testing, result, test, reset };
}
