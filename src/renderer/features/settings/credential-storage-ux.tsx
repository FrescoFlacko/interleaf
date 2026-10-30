import type { ReactElement } from 'react';
import type { CredentialStorageStatus } from '@shared/schemas/credential-preview';

/** Id of the storage explanation, so the key field can be described by it. */
const CREDENTIAL_STORAGE_NOTE_ID = 'openrouter-storage-note';

const OTHER_PLATFORM_NOTICE =
  'Credential storage is unavailable on this system, so an API key cannot be saved. Interleaf never stores keys in plaintext.';

const LINUX_CAUSE: Readonly<Record<string, string>> = {
  basic_text: 'the only store found keeps secrets in plaintext',
};

const LINUX_DEFAULT_CAUSE = 'no OS secret service was found';

/**
 * What Settings tells the reader when main will refuse to store a key at all
 * (ADR 0009 §5).
 *
 * `null` means either a usable store or a status that has not been read yet,
 * and the UI then stays silent rather than inventing a failure. Main fails
 * closed on the write either way; this only explains the refusal before the
 * user types a key.
 */
export function credentialStorageNotice(
  storage: CredentialStorageStatus | null
): string | null {
  if (storage === null || storage.available) return null;
  if (storage.platform !== 'linux') return OTHER_PLATFORM_NOTICE;
  const cause = LINUX_CAUSE[storage.backend] ?? LINUX_DEFAULT_CAUSE;
  return `Credential storage is unavailable: ${cause}. On Omarchy or Arch, install and unlock gnome-keyring (pacman -S gnome-keyring libsecret) so it starts with your Hyprland session, then restart Interleaf.`;
}

/** Whether a credential write is refused before it is attempted. */
export function credentialStorageBlocked(
  storage: CredentialStorageStatus | null
): boolean {
  return credentialStorageNotice(storage) !== null;
}

/**
 * The key field's descriptions, in reading order, or none at all: the storage
 * explanation, the state note, and the validation error are announced
 * together rather than replacing one another.
 */
export function keyDescribedBy(options: {
  readonly storageBlocked: boolean;
  readonly hasNote: boolean;
  readonly hasError: boolean;
}): string | undefined {
  const ids = [
    ...(options.storageBlocked ? [CREDENTIAL_STORAGE_NOTE_ID] : []),
    ...(options.hasNote ? ['openrouter-key-note'] : []),
    ...(options.hasError ? ['openrouter-key-error'] : []),
  ];
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** Inline, accessible explanation rendered above the key field. */
export function CredentialStorageNotice({
  storage,
}: {
  readonly storage: CredentialStorageStatus | null;
}): ReactElement | null {
  const notice = credentialStorageNotice(storage);
  if (notice === null) return null;
  return (
    <span
      id={CREDENTIAL_STORAGE_NOTE_ID}
      role="status"
      data-testid="openrouter-storage-unavailable"
      className="settings-field-note text-warning"
    >
      {notice}
    </span>
  );
}

const OPENROUTER_KEY_GRAMMAR = /^sk-or-v1-[A-Za-z0-9_-]+$/u;
const INVALID_KEY = 'Please enter a valid API key.';
const BLOCKED_KEY = 'Credential storage is unavailable, so an API key cannot be saved yet.';

/**
 * Why the OpenRouter key field blocks a save, or `null` when it does not.
 *
 * An empty field is fine when a key is already stored, and also when the
 * credential store is unavailable: Settings must not demand a key that main
 * would refuse to keep, so the rest of the dialog still saves and closes. A
 * typed key is refused outright in that state — the field is disabled, so it
 * can only arrive from a state the panel did not offer.
 */
export function openRouterKeyIssue(input: {
  readonly storageBlocked: boolean;
  readonly configured: boolean;
  readonly draft: string;
}): string | null {
  if (input.draft.length === 0) return input.configured || input.storageBlocked ? null : INVALID_KEY;
  if (input.storageBlocked) return BLOCKED_KEY;
  return OPENROUTER_KEY_GRAMMAR.test(input.draft) ? null : INVALID_KEY;
}
