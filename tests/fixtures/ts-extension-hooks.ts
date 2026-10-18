/**
 * Preloaded with `--import` by child processes that run application source
 * directly under Node's type stripping, such as `zip-inflate-child.ts`.
 *
 * Node strips the types, but its ESM resolver still requires an explicit
 * extension, and the source imports its siblings without one. This hook only
 * retries a relative specifier with `.ts`; it never invents a module that does
 * not exist.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
