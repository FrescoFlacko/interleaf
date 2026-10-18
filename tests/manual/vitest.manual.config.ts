/**
 * Config for opt-in manual checks.
 *
 * Kept separate from `vitest.config.ts` so that nothing under `tests/manual/`
 * can be picked up by `npm run test`: these files talk to real local software
 * and are run deliberately, by hand.
 *
 *   npx vitest run --config tests/manual/vitest.manual.config.ts
 */
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

// `include` is replaced rather than merged, so a manual run executes only the
// manual checks.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/manual/**/*.manual.ts'],
  },
});
