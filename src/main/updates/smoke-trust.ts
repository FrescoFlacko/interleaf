import { z } from 'zod';
import { parsePortableJson } from '@shared/models/portable';
import { UPDATE_TRUST, type UpdateTrust } from './update-trust';

/**
 * The trust anchor of a packaged update smoke build, and only of one.
 *
 * electron.update-smoke.ts builds two throwaway versions with
 * `INTERLEAF_UPDATE_SMOKE_TRUST` set, which electron.vite.config.ts inlines
 * here as a compile-time constant. Every other build inlines `null`, so this
 * returns the production `UPDATE_TRUST` unchanged. Nothing is read at
 * runtime: no environment variable, setting or renderer request of a running
 * app can reach this value.
 *
 * A smoke anchor may only name a loopback origin and the ephemeral key the
 * smoke run generated (and deletes), so even a smoke build that escaped would
 * accept updates from nowhere but its own machine's loopback, signed by a key
 * that no longer exists. A malformed anchor pins no key, which fails closed.
 * Both release tools refuse to run while the variable is set.
 */

declare const __INTERLEAF_UPDATE_SMOKE_TRUST__: string | null;

const smokeTrustSchema = z
  .object({
    origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/),
    signingKeys: z
      .array(z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), spkiBase64: z.string().min(1).max(256) }).strict())
      .length(1),
  })
  .strict();

/** The anchor a build inlined: `null` means production. */
export function trustFromSmokeAnchor(anchor: string | null): UpdateTrust {
  if (anchor === null) return UPDATE_TRUST;
  let parsed: ReturnType<typeof smokeTrustSchema.safeParse>;
  try {
    parsed = smokeTrustSchema.safeParse(parsePortableJson(anchor));
  } catch {
    return { ...UPDATE_TRUST, signingKeys: [] };
  }
  if (!parsed.success) return { ...UPDATE_TRUST, signingKeys: [] };
  return { ...UPDATE_TRUST, origin: parsed.data.origin, signingKeys: parsed.data.signingKeys };
}

/** Whether this build was compiled as an update smoke build. */
export function isSmokeBuild(): boolean {
  return typeof __INTERLEAF_UPDATE_SMOKE_TRUST__ === 'string';
}

export function buildUpdateTrust(): UpdateTrust {
  return trustFromSmokeAnchor(isSmokeBuild() ? __INTERLEAF_UPDATE_SMOKE_TRUST__ : null);
}
