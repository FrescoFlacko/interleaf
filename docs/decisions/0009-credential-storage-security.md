# ADR 0009: Credential Storage Security & Secret Management

## Status
Accepted — invariant 5 implemented (`CredentialVault.describeStorage` /
`requireEncryption` in `src/main/ai/credential-vault.ts`, projected by
`credentials:get-status` and explained in the OpenRouter settings panel).

## Context & Problem Statement
Interleaf allows users to configure external API keys (e.g. OpenRouter) to enable conversational AI features. Storing API keys in plaintext inside SQLite databases, localStorage, JSON settings files, or memory dumps exposes users to credential theft from local malware or accidental repository commits.

## Decision Drivers
- Strongest available OS-backed encryption-at-rest with explicit backend detection and fail-closed policy.
- Zero plaintext credential leakage into application logs, error reports, or SQLite database backups.
- Strict isolation from the renderer process: React components should never have direct access to raw API keys.
- Adherence to the `security-and-hardening` skill rules.

## Considered Options
1. **Option 1: Renderer `localStorage` / Plain JSON Settings** — Store API keys in plaintext in the browser runtime or `settings.json`. (Rejected: Completely insecure; readable by any renderer XSS).
2. **Option 2: Application-Level Static Encryption Key** — Encrypt secrets using a hardcoded AES key in the codebase. (Rejected: Trivial to reverse-engineer).
3. **Option 3: Electron `safeStorage` with Backend Policy** — Encrypt credentials using Electron's `safeStorage` API, inspect the selected backend, and reject or explicitly warn on weak/unavailable Linux backends.

## Decision Outcome
Chosen **Option 3**.

### Architectural Invariants
1. **Encryption via `safeStorage` and a dedicated vault file**:
   ```typescript
   export function storeEncryptedSecret(keyName: string, rawSecret: string): void {
     if (!safeStorage.isEncryptionAvailable()) {
       throw new Error('OS credential encryption is not available on this system.');
     }
     const encryptedBuffer = safeStorage.encryptString(rawSecret);
     credentialVault.writeAtomic({
       id: keyName,
       ciphertext: encryptedBuffer.toString('base64'),
       version: 1,
     });
     settings.setCredentialReference(keyName, { recordId: keyName, configured: true });
   }
   ```
2. **Preload & Renderer Masking**: Plaintext exists transiently in the secure renderer input and the validated `credentials.set` IPC request when the user pastes it. It is never returned to the renderer, retained in application state, persisted outside the encrypted vault, or logged. Responses return only `{ configured: boolean, preview: 'sk-or-v1-••••••••' }`; the input is cleared after acknowledgement.
3. **Subprocess Isolation**: When spawning child agent processes, API keys are injected only if explicitly required by the provider, and redacted in all logs.
4. **Log Redaction**: Structured loggers automatically scrub strings matching API key patterns (`sk-ant-*`, `sk-or-*`, `Bearer *`).
5. **Backend Policy**: Main records `safeStorage.getSelectedStorageBackend()` as non-secret diagnostics. macOS/Windows supported backends proceed; Linux `basic_text` or unavailable encryption fails closed by default and the UI explains how to configure a Secret Service. No silent plaintext fallback exists.
6. **Ciphertext Lifecycle**: Ciphertext is stored only in an app-owned credential vault file with restrictive permissions; settings store only a credential record ID/configured flag. Key rotation writes new ciphertext atomically before deleting the old record. OS-account/keychain migration failures preserve ciphertext and surface a reconnect flow rather than erasing it.

## Consequences
- **Positive**: Uses the platform-selected OS protection when an acceptable backend is available and never silently stores plaintext.
- **Positive**: Ciphertext is not useful without the originating OS account/key material under supported backends.
- **Negative**: On headless Linux environments lacking a Secret Service daemon, key storage requires fallback handling.
