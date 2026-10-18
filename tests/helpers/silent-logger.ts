import type { Logger } from '../../src/main/logging/logger';

/** A complete logger for tests that do not assert on log output. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
