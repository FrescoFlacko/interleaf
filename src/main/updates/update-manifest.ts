import { z } from 'zod';
import { parsePortableJson, type PortableValue } from '@shared/models/portable';
import { STABLE_VERSION_PATTERN } from '@shared/schemas/updates';
import { UPDATE_MANIFEST_FORMAT, payloadSignatureValid, pinnedKey } from './update-envelope';
import type { UpdateSigningKey, UpdateTrust } from './update-trust';

/**
 * Verification of a signed release manifest.
 *
 * A manifest is a small JSON envelope (update-envelope.ts): the exact UTF-8
 * bytes of the release statement (base64 `payload`), the id of the pinned key
 * that signed it and a detached Ed25519 signature over a domain-prefixed copy
 * of those bytes.
 *
 * Only after the signature verifies is the payload parsed, and then strictly:
 * the product, channel, platform, stable version, tag, architecture and every
 * file's size and SHA-512 must be exactly what this build accepts. The result
 * is the single file for this machine's architecture, and electron-updater's
 * own SHA-512 checks then bind every downloaded, cached or differentially
 * reassembled byte to it.
 */

/** Manifests are a few hundred bytes; anything near this is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

const base64Schema = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const keyIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const sha512Schema = z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/);

const envelopeSchema = z
  .object({
    format: z.literal(UPDATE_MANIFEST_FORMAT),
    keyId: keyIdSchema,
    payload: base64Schema(Math.ceil(MAX_MANIFEST_BYTES / 3) * 4),
    signature: base64Schema(88).length(88),
  })
  .strict();

const UPDATE_ARCHES = ['arm64', 'x64'] as const;
type UpdatePlatform = 'darwin' | 'linux';

const fileSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
    arch: z.enum(UPDATE_ARCHES),
    kind: z.enum(['zip', 'AppImage']),
    size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
    sha512: sha512Schema,
    blockMapSize: z.number().int().positive().max(64 * 1024 * 1024).optional(),
  })
  .strict();

const updateManifestPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.string().min(1).max(128),
    channel: z.literal('stable'),
    platform: z.enum(['darwin', 'linux']),
    version: z.string().max(24).regex(STABLE_VERSION_PATTERN),
    tag: z.string().max(32),
    releaseDate: z.iso.datetime().max(40),
    files: z.array(fileSchema).min(1).max(8),
  })
  .strict();

type UpdateManifestPayload = z.infer<typeof updateManifestPayloadSchema>;
type UpdateManifestFile = z.infer<typeof fileSchema>;

export type VerifiedRelease = {
  readonly version: string;
  readonly tag: string;
  readonly releaseDate: string;
  readonly file: UpdateManifestFile;
};

export type ManifestExpectation = {
  readonly trust: UpdateTrust;
  readonly platform: UpdatePlatform;
  readonly arch: string;
};

/** A manifest that is malformed, unsigned, signed by an unpinned key or not meant for this build. */
export class UpdateVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Update manifest rejected: ${reason}`);
    this.name = 'UpdateVerificationError';
  }
}

const KIND_FOR_PLATFORM: Readonly<Record<UpdatePlatform, UpdateManifestFile['kind']>> = { darwin: 'zip', linux: 'AppImage' };

function parseJson(text: string): PortableValue {
  try {
    return parsePortableJson(text);
  } catch {
    throw new UpdateVerificationError('not JSON');
  }
}

/** Checks the envelope and its signature, returning the exact signed payload bytes. */
function verifiedPayloadBytes(text: string, keys: readonly UpdateSigningKey[]): Buffer {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new UpdateVerificationError('too large');
  const envelope = envelopeSchema.safeParse(parseJson(text));
  if (!envelope.success) throw new UpdateVerificationError('malformed envelope');
  const key = pinnedKey(keys, envelope.data.keyId);
  if (key === undefined) throw new UpdateVerificationError('signed by a key this build does not trust');
  const payload = Buffer.from(envelope.data.payload, 'base64');
  const signature = Buffer.from(envelope.data.signature, 'base64');
  if (!payloadSignatureValid(payload, signature, key)) {
    throw new UpdateVerificationError('signature does not verify');
  }
  return payload;
}

/** The one file for this platform and architecture, after the whole file list is checked for consistency. */
function selectFile(payload: UpdateManifestPayload, expectation: ManifestExpectation): UpdateManifestFile {
  const names = new Set(payload.files.map((file) => file.name));
  if (names.size !== payload.files.length) throw new UpdateVerificationError('duplicate file names');
  const kind = KIND_FOR_PLATFORM[expectation.platform];
  for (const file of payload.files) {
    const archTagged = file.name.includes('arm64');
    if (file.kind !== kind || !file.name.includes(payload.version) || archTagged !== (file.arch === 'arm64')) {
      throw new UpdateVerificationError(`file ${file.name} does not match the release`);
    }
  }
  const matches = payload.files.filter((file) => file.arch === expectation.arch);
  const [file] = matches;
  if (matches.length !== 1 || file === undefined) throw new UpdateVerificationError(`no single ${expectation.arch} file`);
  return file;
}

export function verifyUpdateManifest(text: string, expectation: ManifestExpectation): VerifiedRelease {
  const payloadBytes = verifiedPayloadBytes(text, expectation.trust.signingKeys);
  const parsed = updateManifestPayloadSchema.safeParse(parseJson(payloadBytes.toString('utf8')));
  if (!parsed.success) throw new UpdateVerificationError('malformed payload');
  const payload = parsed.data;
  if (payload.product !== expectation.trust.product) throw new UpdateVerificationError('wrong product');
  if (payload.platform !== expectation.platform) throw new UpdateVerificationError('wrong platform');
  if (payload.tag !== `v${payload.version}`) throw new UpdateVerificationError('tag does not match version');
  return { version: payload.version, tag: payload.tag, releaseDate: payload.releaseDate, file: selectFile(payload, expectation) };
}
