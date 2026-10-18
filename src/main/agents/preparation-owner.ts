import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isPortableRecord, parsePortableJson, type PortableMember, type PortableValue } from '@shared/models/portable';

/**
 * Item J correction: the non-forgeable half of preparation ownership.
 *
 * The journal used to prove ownership with a UUID stored *inside* the session
 * root it described. That is self-assertion, not ownership: the session root is
 * the subtree an agent runs in, so anything able to write there could mint a
 * syntactically perfect journal — for its own root, or for another session's —
 * and have startup treat it as an abandoned preparation of ours and remove it.
 * Authority over a deletion decision must never live in data the thing being
 * judged can write.
 *
 * So the authority moves out of that subtree and out of reach of a
 * workspace-scoped writer: one main-created marker file, minted once per
 * installation, held *outside* the agent environment root, holding an
 * installation id and a random secret. Journals carry an HMAC over their own
 * canonical fields; reconciliation recomputes it. A journal that does not
 * verify is not ours, whatever it says about itself.
 *
 * Residual, stated rather than claimed away: this is not an OS isolation
 * boundary. A process running as the same user with no path restriction can
 * read any file that user can read, including this marker. What it defeats is
 * forgery through renderer-, workspace- or model-writable data — the paths an
 * agent actually writes through — not a same-uid attacker with arbitrary
 * filesystem reach, which this application cannot defend against anywhere.
 */
export type PreparationOwner = {
  readonly installationId: string;
  readonly secret: Buffer;
};

const MAX_MARKER_BYTES = 4 * 1024;
const SECRET_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function parseMarker(raw: string): PreparationOwner | null {
  let value: PortableValue;
  try { value = parsePortableJson(raw); } catch { return null; }
  if (!isPortableRecord(value)) return null;
  const record = value;
  if (record.version !== 1) return null;
  if (typeof record.installationId !== 'string' || !UUID_RE.test(record.installationId)) return null;
  if (typeof record.secret !== 'string' || record.secret.length !== SECRET_BYTES * 2 || !/^[a-f0-9]+$/iu.test(record.secret)) return null;
  return { installationId: record.installationId, secret: Buffer.from(record.secret, 'hex') };
}

/**
 * Opens the marker no-follow and proves it is a plain, app-owned, private file
 * before believing a byte of it. A marker readable or writable by anyone else,
 * or reached through a link, is not an authority record.
 */
async function readMarker(markerPath: string): Promise<PreparationOwner | null> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle;
  try { handle = await open(markerPath, fsConstants.O_RDONLY | noFollow); } catch { return null; }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size === 0 || details.size > MAX_MARKER_BYTES) {
      throw new InterleafError('security-violation', 'The preparation owner marker is not a bounded regular file.');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && details.uid !== uid) {
      throw new InterleafError('security-violation', 'The preparation owner marker is owned by another user.');
    }
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
      throw new InterleafError('security-violation', 'The preparation owner marker is accessible beyond this application.');
    }
    const owner = parseMarker((await handle.readFile()).toString('utf8'));
    if (owner === null) throw new InterleafError('security-violation', 'The preparation owner marker is malformed.');
    return owner;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code !== 'EBADF' && code !== 'EISDIR' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  }
}

async function mintMarker(markerPath: string): Promise<void> {
  const serialized = JSON.stringify({ version: 1, installationId: randomUUID(), secret: randomBytes(SECRET_BYTES).toString('hex') });
  const temporary = `${markerPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // `link` semantics would be stronger, but `rename` matches every other
    // durable record here and a concurrent minter is resolved by re-reading.
    await rename(temporary, markerPath);
    await syncDirectory(dirname(markerPath));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Loads the installation's preparation owner, minting it on first use. Failure
 * to establish one is fatal to preparation: without it no journal can be proved
 * ours, and an unprovable journal must never authorize a removal.
 */
export async function loadPreparationOwner(markerPath: string): Promise<PreparationOwner> {
  const path = resolve(markerPath);
  const existing = await readMarker(path);
  if (existing !== null) return existing;
  await mintMarker(path);
  const minted = await readMarker(path);
  if (minted === null) throw new InterleafError('internal', 'The preparation owner marker could not be established.');
  return minted;
}

export function signPreparationRecord(owner: PreparationOwner, canonical: string): string {
  return createHmac('sha256', owner.secret).update(`${owner.installationId}\u0000${canonical}`, 'utf8').digest('hex');
}

export function verifyPreparationRecord(owner: PreparationOwner, canonical: string, mac: PortableMember): boolean {
  if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/iu.test(mac)) return false;
  const expected = Buffer.from(signPreparationRecord(owner, canonical), 'hex');
  const actual = Buffer.from(mac.toLowerCase(), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
