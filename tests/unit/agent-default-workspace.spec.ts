import { describe, expect, it } from 'vitest';
import { agentSettingsSchema, type AppSettings } from '../../src/shared/schemas/settings';
describe('Agent Default Workspace Schema and Persistence', () => {
  const dir1 = { handle: 'handle-ws-1', displayName: 'Workspace One' };

  it('allows defaultWorkingDirectory to be null', () => {
    const valid: AppSettings['agent'] = {
      defaultExecutionMode: 'auto-isolated',
      defaultProfileId: null,
      defaultWorkingDirectory: null,
      workingDirectories: [dir1],
      defaultWorkingDirectoryByProfile: {},
      profiles: {},
    };

    const parsed = agentSettingsSchema.parse(valid);
    expect(parsed.defaultWorkingDirectory).toBeNull();
  });

  it('defaults defaultWorkingDirectory to null when omitted', () => {
    const minimal = {
      defaultExecutionMode: 'auto-isolated' as const,
      workingDirectories: [],
      defaultWorkingDirectoryByProfile: {},
      profiles: {},
    };

    const parsed = agentSettingsSchema.parse(minimal);
    expect(parsed.defaultWorkingDirectory).toBeNull();
  });

  it('rejects path-like values as defaultWorkingDirectory handles', () => {
    const invalidPath = {
      defaultExecutionMode: 'auto-isolated' as const,
      defaultWorkingDirectory: '/Users/test/workspace',
      workingDirectories: [{ handle: '/Users/test/workspace', displayName: 'Path' }],
      defaultWorkingDirectoryByProfile: {},
      profiles: {},
    };

    const result = agentSettingsSchema.safeParse(invalidPath);
    expect(result.success).toBe(false);
  });
});
