import type { CredentialVault } from '../../src/main/ai/credential-vault';
import type { AIProviderRegistry } from '../../src/main/ai/provider-registry';
import { DEFAULT_APP_SETTINGS } from '../../src/shared/schemas/settings';
import { silentLogger } from './silent-logger';
import { unstubbed } from './unstubbed';

type AIProviderRegistryInput = ConstructorParameters<typeof AIProviderRegistry>[0];

/**
 * Complete registry input as an unpackaged development build wires it, with
 * test doubles off. The vault is an {@link unstubbed} double, so a test that
 * reaches stored credentials without supplying them fails by name.
 */
export function testAIProviderRegistryInput(overrides: Partial<AIProviderRegistryInput> = {}): AIProviderRegistryInput {
  return {
    chatRoot: '/tmp/interleaf-test-chat',
    vault: unstubbed<CredentialVault>('vault'),
    allowFakeProvider: false,
    isPackaged: false,
    logger: silentLogger,
    readLocalSettings: () => DEFAULT_APP_SETTINGS.ai.local,
    modelListing: undefined,
    ...overrides,
  };
}
