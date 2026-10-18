/**
 * Brand-scoped process environment lookup.
 *
 * The canonical variables are `INTERLEAF_*`. The pre-rebrand `MARGINLAB_*`
 * spelling is still accepted so a developer shell, script, or launch
 * configuration written before the rename keeps working; nothing in the app
 * ever writes the legacy name. Renderer processes cannot influence these
 * values — every read happens in the main process.
 */

const BRAND_ENV_PREFIX = 'INTERLEAF_' as const;
const LEGACY_BRAND_ENV_PREFIX = 'MARGINLAB_' as const;

/**
 * Reads `INTERLEAF_<suffix>`, falling back to the legacy `MARGINLAB_<suffix>`.
 * Empty values are treated as absent so an exported-but-blank variable does
 * not silently enable a seam.
 */
export function readBrandEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const current = env[`${BRAND_ENV_PREFIX}${suffix}`];
  if (current !== undefined && current.length > 0) return current;
  const legacy = env[`${LEGACY_BRAND_ENV_PREFIX}${suffix}`];
  if (legacy !== undefined && legacy.length > 0) return legacy;
  return undefined;
}

/** True when the brand-scoped flag is explicitly set to `1`. */
export function brandEnvFlagEnabled(suffix: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readBrandEnv(suffix, env) === '1';
}
