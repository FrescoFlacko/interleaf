import { expect, test } from '@playwright/test';
import { launchInterleaf } from './helpers';
import type { SecureKeyringBackend } from './secure-keyring-preload';

test('the opted-in private Linux session uses real OS-backed credential encryption', async () => {
  test.skip(process.platform !== 'linux' || process.env.INTERLEAF_E2E_SECRET_SERVICE !== '1', 'Requires an explicitly isolated Linux Secret Service session.');
  const app = await launchInterleaf();
  try {
    const result = await app.electronApp.evaluate(({ safeStorage }) => {
      const backend = safeStorage.getSelectedStorageBackend();
      const available = safeStorage.isEncryptionAvailable();
      const value = 'interleaf-private-test-fixture';
      const roundtrip = available && safeStorage.decryptString(safeStorage.encryptString(value)) === value;
      return { backend, available, roundtrip };
    });
    const expectedBackend: SecureKeyringBackend = 'gnome_libsecret';
    expect(result).toEqual({ backend: expectedBackend, available: true, roundtrip: true });
  } finally { await app.close(); }
});
