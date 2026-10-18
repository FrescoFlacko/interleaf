import type { CredentialStorageStatus, OpenRouterCredentialStatus } from '@shared/schemas/credential-preview';

/** The storage diagnostic main reports for a usable OS keychain. */
export const USABLE_CREDENTIAL_STORAGE: CredentialStorageStatus = {
  available: true,
  backend: 'os_keychain',
  platform: 'darwin',
};

/** The complete status main reports when no OpenRouter key is stored. */
export const UNCONFIGURED_CREDENTIAL_STATUS: OpenRouterCredentialStatus = {
  configured: false,
  keyPreview: null,
  storageBackend: USABLE_CREDENTIAL_STORAGE,
};
