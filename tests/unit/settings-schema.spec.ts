import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository, validateAgentProfileSettings } from '@main/db/repositories/settings-repository';
import {
  appSettingsSchema,
  DEFAULT_APP_SETTINGS,
  MAX_DEFAULT_WORKING_DIRECTORY_PROFILES,
  MAX_SAVED_WORKING_DIRECTORIES,
} from '@shared/schemas/settings';
import { configureOpenRouterRequestSchema, openRouterModelIdSchema } from '@shared/schemas/ai';
import { DEFAULT_LOCAL_ENDPOINT } from '@shared/schemas/local-endpoint';
import type { Logger } from '@main/logging/logger';
import type { PortableRecord } from '@shared/models/portable';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('Reusable working-directory settings contracts', () => {
  it('backward-parses settings written before reusable directories existed', () => {
    const legacy = {
      ...DEFAULT_APP_SETTINGS,
      agent: { defaultExecutionMode: 'auto-isolated' as const },
    };
    const parsed = appSettingsSchema.parse(legacy);
    expect(parsed.agent.workingDirectories).toEqual([]);
    expect(parsed.agent.defaultWorkingDirectoryByProfile).toEqual({});
    expect(parsed.agent.profiles).toEqual({});
  });

  it('bounds and de-duplicates public capability entries', () => {
    const tooMany = Array.from({ length: MAX_SAVED_WORKING_DIRECTORIES + 1 }, (_, index) => ({
      handle: `handle-${String(index)}`,
      displayName: `Directory ${String(index)}`,
    }));
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, workingDirectories: tooMany },
    }).success).toBe(false);

    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        workingDirectories: [
          { handle: 'same-handle', displayName: 'First' },
          { handle: 'same-handle', displayName: 'Second' },
        ],
      },
    }).success).toBe(false);
  });

  it('rejects path-shaped or expanded public entries', () => {
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        workingDirectories: [{ handle: '/tmp/project', displayName: 'project' }],
      },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        workingDirectories: [{ handle: 'project', displayName: 'project', canonicalPath: '/tmp/project' }],
      },
    }).success).toBe(false);
  });

  it('enforces mapping membership, bounded profile count, and profile-key allowlists', () => {
    const saved = { handle: 'workspace', displayName: 'Workspace' };
    const base = { ...DEFAULT_APP_SETTINGS, agent: { ...DEFAULT_APP_SETTINGS.agent, workingDirectories: [saved] } };
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectoryByProfile: { codex: 'missing' } },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectoryByProfile: { 'custom:not-a-uuid': 'workspace' } },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectoryByProfile: { 'custom:550e8400-e29b-41d4-a716-446655440000': 'workspace' } },
    }).success).toBe(true);
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectory: 'workspace' },
    }).success).toBe(true);
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectory: 'not-in-saved-list' },
    }).success).toBe(false);

    const tooManyProfiles = Object.fromEntries(
      Array.from({ length: MAX_DEFAULT_WORKING_DIRECTORY_PROFILES + 1 }, (_, index) => [
        `custom:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        'workspace',
      ])
    );
    expect(appSettingsSchema.safeParse({
      ...base,
      agent: { ...base.agent, defaultWorkingDirectoryByProfile: tooManyProfiles },
    }).success).toBe(false);
  });
});

describe('OpenRouter model setting and validation boundary', () => {
  it('treats staged removal as mutually exclusive with any replacement-key field', () => {
    expect(configureOpenRouterRequestSchema.safeParse({ removeKey: true, model: 'openrouter/auto' }).success).toBe(true);
    expect(configureOpenRouterRequestSchema.safeParse({ removeKey: true, apiKey: '', model: 'openrouter/auto' }).success).toBe(false);
    expect(configureOpenRouterRequestSchema.safeParse({ removeKey: true, apiKey: 'sk-or-v1-replacement', model: 'openrouter/auto' }).success).toBe(false);
  });

  it.each([
    'openrouter/auto',
    'anthropic/claude-3.5-sonnet',
    'anthropic/claude-3.7-sonnet:thinking',
    'meta-llama/llama-3.1-70b-instruct',
  ])('accepts the provider and model identifier %s', (id) => {
    expect(openRouterModelIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    // Empty, whitespace-only, or spaced.
    '', '   ', 'anthropic / claude',
    // Bare IDs, extra slashes, and extra colon variants.
    'model', 'org/team/model', 'anthropic/claude-3.5-sonnet:free:nitro',
    // Traversal, leading and trailing separators, doubled separators.
    '../traversal', 'foo/../bar', '/leading/slash', 'trailing/slash/', ':leading/colon',
    'trailing/colon:', 'double//slash', 'double::colon',
    // Invalid symbols and oversized strings.
    'model$name', 'model;rm -rf', 'a'.repeat(129),
  ])('rejects the model identifier %j', (id) => {
    expect(openRouterModelIdSchema.safeParse(id).success).toBe(false);
  });

  it.each([
    ['anthropic/claude-3.7-sonnet:thinking', true],
    ['', false],
    ['invalid model id', false],
    ['../traversal', false],
  ])('enforces openRouterModel %j validation in appSettingsSchema', (openRouterModel, expected) => {
    const settings = { ...DEFAULT_APP_SETTINGS, ai: { openRouterModel } };
    expect(appSettingsSchema.safeParse(settings).success).toBe(expected);
  });

  describe('SettingsRepository persistence', () => {
    let db: InterleafDatabase;
    let repo: SettingsRepository;

    beforeEach(() => {
      db = InterleafDatabase.open(':memory:');
      runMigrations(db);
      repo = new SettingsRepository(db, logger);
    });

    afterEach(() => {
      db.close();
    });

    it('persists and retrieves valid OpenRouter model setting', () => {
      const initial = repo.get();
      expect(initial.ai.openRouterModel).toBe('openrouter/auto');

      const updated = repo.update({
        ...initial,
        ai: { openRouterModel: 'anthropic/claude-3.7-sonnet:thinking' },
      });
      expect(updated.ai.openRouterModel).toBe('anthropic/claude-3.7-sonnet:thinking');
      expect(repo.get().ai.openRouterModel).toBe('anthropic/claude-3.7-sonnet:thinking');
    });

    it('rejects invalid OpenRouter model update', () => {
      const initial = repo.get();
      expect(() =>
        repo.update({
          ...initial,
          ai: { openRouterModel: 'invalid with spaces' },
        })
      ).toThrow();
    });

    const profile = (overrides: PortableRecord) => ({
      binary: 'codex',
      arguments: ['exec', '--json', '--sandbox', 'workspace-write'],
      defaultModel: null,
      reasoningEffort: null,
      permissionMode: 'workspace-write',
      sandboxMode: 'auto-isolated',
      workingDirectoryPolicy: 'select-per-run',
      environmentOverrides: [],
      ...overrides,
    });
    const claudeArgs = ['--print', '--output-format', 'stream-json', '--verbose'];
    const cursorArgs = ['--print', '--output-format', 'stream-json'];
    const updateProfiles = (profiles: Record<string, ReturnType<typeof profile>>) => {
      const initial = repo.get();
      return repo.update({ ...initial, agent: { ...initial.agent, profiles } } as never);
    };

    it('persists bounded main-owned agent profile preferences', () => {
      const updated = updateProfiles({
        codex: profile({
          defaultModel: 'gpt-5-codex',
          reasoningEffort: 'high',
          environmentOverrides: [{ name: 'PATH', action: 'inherit-allowlisted' }],
        }),
      });
      expect(updated.agent.profiles.codex?.defaultModel).toBe('gpt-5-codex');
      expect(repo.get().agent.profiles.codex?.arguments).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
    });

    it('rejects renderer attempts to change executable, argv, or secret environment policy', () => {
      const initial = repo.get();
      const secretEnvironment = [{ name: 'OPENROUTER_API_KEY', action: 'inherit-allowlisted' as const }];
      const withCodex = (args: string[]) => ({
        ...initial,
        agent: {
          ...initial.agent,
          profiles: {
            codex: {
              binary: 'codex' as const,
              arguments: args,
              defaultModel: null,
              models: [],
              reasoningEffort: null,
              permissionMode: 'workspace-write' as const,
              sandboxMode: 'auto-isolated' as const,
              workingDirectoryPolicy: 'select-per-run' as const,
              environmentOverrides: secretEnvironment,
            },
          },
        },
      });
      const candidate = withCodex(['sh', '-c', 'rm -rf /']);
      expect(appSettingsSchema.safeParse(candidate).success).toBe(true);
      expect(() => { validateAgentProfileSettings(candidate); }).toThrow(/allowlisted preset/u);
      expect(() => repo.update(candidate)).toThrow();

      expect(() => repo.update(withCodex(['exec', '--json', '--sandbox', 'workspace-write']))).toThrow(/non-secret allowlist/u);

      const bypassCandidate = withCodex(['exec', '--json', '--skip-git-repo-check']);
      expect(appSettingsSchema.safeParse(bypassCandidate).success).toBe(false);
      expect(() => repo.update(bypassCandidate)).toThrow(/repository-check bypass/u);
    });

    it('downgrades the legacy reusable-directory preference to per-run capability selection', () => {
      const initial = repo.get();
      const legacy = {
        ...initial,
        agent: { ...initial.agent, profiles: { codex: profile({ workingDirectoryPolicy: 'reuse-last-selected' }) } },
      };
      db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(legacy), 'app');
      expect(repo.get().agent.profiles.codex?.workingDirectoryPolicy).toBe('select-per-run');
    });

    it('safely downgrades stale/unsupported profile reasoningEffort from older previews to null without discarding the settings document', () => {
      const initial = repo.get();
      const legacy = {
        ...initial,
        appearance: { palette: 'moss' as const },
        reader: { ...initial.reader, fontSize: 1.4, fontFamily: 'serif' as const },
        agent: {
          ...initial.agent,
          profiles: {
            // Invalid for Codex (supported: low, medium, high).
            codex: profile({ reasoningEffort: 'max' }),
            // Valid for Claude.
            'claude-code': profile({ binary: 'claude', arguments: claudeArgs, reasoningEffort: 'xhigh', permissionMode: 'normal' }),
          },
        },
      };
      db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(legacy), 'app');
      const loaded = repo.get();
      expect(loaded.agent.profiles.codex?.reasoningEffort).toBeNull();
      expect(loaded.agent.profiles['claude-code']?.reasoningEffort).toBe('xhigh');
      // Unrelated settings fully preserved.
      expect(loaded.appearance.palette).toBe('moss');
      expect(loaded.reader.fontSize).toBe(1.4);
      expect(loaded.reader.fontFamily).toBe('serif');
    });

    it('requires the explicit unsafe Codex preset to match its unsafe permission mode', () => {
      const unsafe = profile({ arguments: ['exec', '--json', '--yolo'], permissionMode: 'unsafe-yolo' });
      expect(() => updateProfiles({ codex: unsafe })).not.toThrow();
      expect(() => updateProfiles({ codex: { ...unsafe, permissionMode: 'workspace-write' } })).toThrow(/unsafe permission mode/u);
    });

    it.each([
      // Safe Codex must have workspace-write.
      ['codex', profile({ permissionMode: 'normal' }), /permission mode/u],
      // Claude Code and Copilot must have normal.
      ['claude-code', profile({ binary: 'claude', arguments: claudeArgs, permissionMode: 'unsafe-yolo' }), /requires permission mode 'normal'/u],
      ['copilot', profile({ binary: 'copilot', arguments: ['--stream', 'on'], permissionMode: 'unsafe-yolo' }), /requires permission mode 'normal'/u],
      ['fake', profile({ binary: 'interleaf-fake', arguments: [], permissionMode: 'normal' }), /Invalid input|expected/u],
    ] as const)('rejects a renderer-supplied %s preset mismatch', (id, candidate, error) => {
      expect(() => updateProfiles({ [id]: candidate })).toThrow(error);
    });

    it.each([
      ['copilot', profile({ binary: 'copilot', arguments: ['--stream', 'on'], reasoningEffort: 'high', permissionMode: 'normal' })],
      ['pi', profile({ binary: 'pi', arguments: [], reasoningEffort: 'low', permissionMode: 'normal' })],
      // Cursor's capability table says reasoningSelection: false.
      ['cursor', profile({ binary: 'cursor-agent', arguments: cursorArgs, reasoningEffort: 'high', permissionMode: 'normal' })],
    ] as const)('rejects a non-null reasoningEffort on %s, which does not support reasoning selection', (id, candidate) => {
      expect(() => updateProfiles({ [id]: candidate })).toThrow(/does not support reasoning effort selection/u);
    });

    it('accepts the documented Cursor argv preset and rejects an approval-bypassing one', () => {
      const cursorProfile = (args: readonly string[]) =>
        profile({ binary: 'cursor-agent', arguments: [...args], permissionMode: 'normal' });

      const saved = updateProfiles({ cursor: cursorProfile(cursorArgs) });
      expect(saved.agent.profiles.cursor?.binary).toBe('cursor-agent');
      expect(saved.agent.profiles.cursor?.arguments).toEqual(['--print', '--output-format', 'stream-json']);

      // `--force` bypasses Cursor's approvals and is not an allowlisted preset,
      // so no persisted preference can ever reach it.
      expect(() => updateProfiles({ cursor: cursorProfile([...cursorArgs, '--force']) })).toThrow(/are not an allowlisted preset/u);

      // The binary is main-owned: a preference cannot substitute another one.
      expect(() => updateProfiles({ cursor: { ...cursorProfile(cursorArgs), binary: 'codex' } })).toThrow(/must use its main-owned binary/u);
    });

    it.each([
      // Codex and Antigravity support only low | medium | high.
      ['codex', 'max', profile({ reasoningEffort: 'max' })],
      ['codex', 'minimal', profile({ reasoningEffort: 'minimal' })],
      ['antigravity', 'max', profile({ binary: 'agy', arguments: cursorArgs, reasoningEffort: 'max', permissionMode: 'normal' })],
      // Claude Code supports low | medium | high | xhigh | max.
      ['claude-code', 'minimal', profile({ binary: 'claude', arguments: claudeArgs, reasoningEffort: 'minimal', permissionMode: 'normal' })],
    ] as const)('rejects %s reasoning effort %s', (id, effort, candidate) => {
      expect(() => updateProfiles({ [id]: candidate })).toThrow(
        new RegExp(`Reasoning effort '${effort}' is not supported for agent profile '${id}'`, 'u'),
      );
    });
  });
});

describe('Local server provider settings contract', () => {
  it('starts from Ollama’s default address with no model chosen', () => {
    expect(DEFAULT_APP_SETTINGS.ai.local).toEqual({
      mode: 'ollama',
      endpoint: DEFAULT_LOCAL_ENDPOINT,
      model: null,
    });
  });

  it('parses a settings document written before the local provider existed', () => {
    // No migration is required: a document stored by an older build keeps every
    // other preference and gains the local defaults.
    const legacy = { ...DEFAULT_APP_SETTINGS, ai: { openRouterModel: 'anthropic/claude-3.5-sonnet' } };

    const parsed = appSettingsSchema.parse(legacy);
    expect(parsed.ai.openRouterModel).toBe('anthropic/claude-3.5-sonnet');
    expect(parsed.ai.local).toEqual({ mode: 'ollama', endpoint: DEFAULT_LOCAL_ENDPOINT, model: null });
  });

  it('refuses to store an endpoint the loopback policy rejects', () => {
    const withEndpoint = (endpoint: string) => ({
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, local: { ...DEFAULT_APP_SETTINGS.ai.local, endpoint } },
    });
    const rejected = [
      'http://localhost:11434',
      'http://0.0.0.0:11434',
      'http://192.168.1.10:11434',
      'https://127.0.0.1:11434',
      'http://user:pass@127.0.0.1:11434',
      'http://127.0.0.1:11434/v1',
      'http://evil.example:11434',
      '',
    ];
    expect(rejected.map((endpoint) => appSettingsSchema.safeParse(withEndpoint(endpoint)).success))
      .toEqual(rejected.map(() => false));
    expect(appSettingsSchema.safeParse(withEndpoint('http://[::1]:8080')).success).toBe(true);
  });

  describe('SettingsRepository persistence', () => {
    let db: InterleafDatabase;
    let repo: SettingsRepository;

    beforeEach(() => {
      db = InterleafDatabase.open(':memory:');
      runMigrations(db);
      repo = new SettingsRepository(db, logger);
    });

    afterEach(() => { db.close(); });

    it('persists the endpoint mode, address and selected model', () => {
      const initial = repo.get();
      expect(initial.ai.local.endpoint).toBe(DEFAULT_LOCAL_ENDPOINT);

      const updated = repo.update({
        ...initial,
        ai: { ...initial.ai, local: { mode: 'openai-compatible', endpoint: 'http://127.0.0.1:8080', model: 'qwen3:8b' } },
      });
      expect(updated.ai.local).toEqual({ mode: 'openai-compatible', endpoint: 'http://127.0.0.1:8080', model: 'qwen3:8b' });
      expect(repo.get().ai.local.model).toBe('qwen3:8b');
    });

    it('rejects a non-loopback endpoint at the persistence boundary', () => {
      const initial = repo.get();
      expect(() => repo.update({
        ...initial,
        ai: { ...initial.ai, local: { ...initial.ai.local, endpoint: 'http://198.51.100.7:11434' } },
      })).toThrow();
      expect(repo.get().ai.local.endpoint).toBe(DEFAULT_LOCAL_ENDPOINT);
    });
  });
});

describe('Library, Privacy and Advanced settings contracts', () => {
  it('defaults every new section so the controls start from today’s behaviour', () => {
    expect(DEFAULT_APP_SETTINGS.library).toEqual({ defaultView: 'grid', defaultSort: 'recent_added' });
    expect(DEFAULT_APP_SETTINGS.privacy).toEqual({ confirmExternalLinks: false });
    expect(DEFAULT_APP_SETTINGS.advanced).toEqual({ debugLogging: false });
  });

  it('parses a settings document written before these sections existed', () => {
    // Exactly what an installation from before this change has stored.
    const legacy: z.input<typeof appSettingsSchema> = { ...DEFAULT_APP_SETTINGS };
    delete legacy.library;
    delete legacy.privacy;
    delete legacy.advanced;

    const parsed = appSettingsSchema.parse(legacy);
    expect(parsed.library).toEqual({ defaultView: 'grid', defaultSort: 'recent_added' });
    expect(parsed.privacy.confirmExternalLinks).toBe(false);
    expect(parsed.advanced.debugLogging).toBe(false);
    // The additive sections do not disturb anything already stored.
    expect(parsed.reader).toEqual(DEFAULT_APP_SETTINGS.reader);
    expect(parsed.layout).toEqual(DEFAULT_APP_SETTINGS.layout);
  });

  it('refuses values outside the supported choices', () => {
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      library: { defaultView: 'columns', defaultSort: 'recent_added' },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      library: { defaultView: 'grid', defaultSort: 'size_desc' },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      privacy: { confirmExternalLinks: 'yes' },
    }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      advanced: { debugLogging: 1 },
    }).success).toBe(false);

    // A half-written section is completed from the defaults, not rejected.
    expect(appSettingsSchema.parse({ ...DEFAULT_APP_SETTINGS, library: { defaultView: 'list' } }).library)
      .toEqual({ defaultView: 'list', defaultSort: 'recent_added' });
  });

  describe('SettingsRepository persistence', () => {
    let db: InterleafDatabase;
    let repo: SettingsRepository;

    beforeEach(() => {
      db = InterleafDatabase.open(':memory:');
      runMigrations(db);
      repo = new SettingsRepository(db, logger);
    });

    afterEach(() => {
      db.close();
    });

    it('round-trips the new preferences and preserves unrelated sections', () => {
      const initial = repo.get();
      const withLayout = repo.update({
        ...initial,
        layout: { ...initial.layout, leftWidth: 301 },
      });

      const saved = repo.update({
        ...withLayout,
        library: { defaultView: 'list', defaultSort: 'title_asc' },
        privacy: { confirmExternalLinks: true },
        advanced: { debugLogging: true },
      });

      expect(saved.library).toEqual({ defaultView: 'list', defaultSort: 'title_asc' });
      expect(saved.privacy.confirmExternalLinks).toBe(true);
      expect(saved.advanced.debugLogging).toBe(true);
      // A settings write from one section never resets another.
      expect(saved.layout.leftWidth).toBe(301);
      expect(saved.reader).toEqual(initial.reader);

      const reread = repo.get();
      expect(reread.library).toEqual({ defaultView: 'list', defaultSort: 'title_asc' });
      expect(reread.privacy.confirmExternalLinks).toBe(true);
      expect(reread.advanced.debugLogging).toBe(true);
      expect(reread.layout.leftWidth).toBe(301);
    });

    it('rejects an unsupported sort rather than storing it', () => {
      const initial = repo.get();
      expect(() =>
        repo.update({
          ...initial,
          library: { defaultView: 'grid', defaultSort: 'newest' as never },
        })
      ).toThrow();
      expect(repo.get().library.defaultSort).toBe('recent_added');
    });

    it('keeps every persistable default execution mode isolated', () => {
      const initial = repo.get();
      expect(() =>
        repo.update({
          ...initial,
          agent: { ...initial.agent, defaultExecutionMode: 'native-restricted' as never },
        })
      ).toThrow();
      expect(() =>
        repo.update({
          ...initial,
          agent: { ...initial.agent, defaultExecutionMode: 'active-env' as never },
        })
      ).toThrow();
      const saved = repo.update({
        ...initial,
        agent: { ...initial.agent, defaultExecutionMode: 'isolated-copy' },
      });
      expect(saved.agent.defaultExecutionMode).toBe('isolated-copy');
    });
  });
});

describe('Startup drawer preference contract', () => {
  it('defaults the AI drawer to open at launch', () => {
    expect(DEFAULT_APP_SETTINGS.layout.openRightPanelOnStartup).toBe(true);
    expect(appSettingsSchema.parse({ version: 1, appearance: { palette: 'moss' }, agent: { defaultExecutionMode: 'auto-isolated' } })
      .layout.openRightPanelOnStartup).toBe(true);
  });

  it('opens the drawer for a layout written before the preference existed and keeps the rest of it', () => {
    const legacy = {
      ...DEFAULT_APP_SETTINGS,
      layout: { leftWidth: 300, rightWidth: 400, leftOpen: false, rightOpen: false },
    };
    expect(appSettingsSchema.parse(legacy).layout).toEqual({
      leftWidth: 300, rightWidth: 400, leftOpen: false, rightOpen: false, openRightPanelOnStartup: true,
    });
  });

  it('refuses a non-boolean preference', () => {
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      layout: { ...DEFAULT_APP_SETTINGS.layout, openRightPanelOnStartup: 'no' },
    }).success).toBe(false);
  });

  describe('SettingsRepository persistence', () => {
    let db: InterleafDatabase;
    let repo: SettingsRepository;

    beforeEach(() => {
      db = InterleafDatabase.open(':memory:');
      runMigrations(db);
      repo = new SettingsRepository(db, logger);
    });

    afterEach(() => {
      db.close();
    });

    it('loads a stored legacy document with the drawer opening at launch and every other preference intact', () => {
      const initial = repo.get();
      const legacy = {
        ...initial,
        appearance: { palette: 'moss' as const },
        library: { defaultView: 'list' as const, defaultSort: 'title_asc' as const },
        layout: { leftWidth: 300, rightWidth: 400, leftOpen: true, rightOpen: false },
      };
      db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(legacy), 'app');

      const loaded = repo.get();
      expect(loaded.layout).toEqual({ ...legacy.layout, openRightPanelOnStartup: true });
      expect(loaded.appearance.palette).toBe('moss');
      expect(loaded.library).toEqual(legacy.library);
    });

    it('round-trips an opted-out preference independently of the live drawer state', () => {
      const initial = repo.get();
      repo.update({ ...initial, layout: { ...initial.layout, rightOpen: true, openRightPanelOnStartup: false } });
      expect(repo.get().layout).toMatchObject({ rightOpen: true, openRightPanelOnStartup: false });

      repo.update({ ...repo.get(), layout: { ...repo.get().layout, rightOpen: false } });
      expect(repo.get().layout).toMatchObject({ rightOpen: false, openRightPanelOnStartup: false });
    });
  });
});

describe('One source for every settings default', () => {
  /** The defaults as they shipped before the sections were derived from field defaults. */
  const SHIPPED_DEFAULTS = {
    version: 1,
    appearance: { palette: 'paper' },
    reader: { background: 'palette', fontSize: 1, fontFamily: 'system', lineSpacing: 1.65, contentWidth: 72, paragraphSpacing: 0.8, pageMargin: 2.5 },
    layout: { leftWidth: 256, rightWidth: 320, leftOpen: true, rightOpen: true, openRightPanelOnStartup: true },
    agent: {
      defaultExecutionMode: 'auto-isolated',
      defaultProfileId: null,
      defaultWorkingDirectory: null,
      workingDirectories: [],
      defaultWorkingDirectoryByProfile: {},
      profiles: {},
    },
    ai: {
      openRouterModel: 'openrouter/auto',
      defaultChat: null,
      conversationNaming: 'auto',
      local: { mode: 'ollama', endpoint: DEFAULT_LOCAL_ENDPOINT, model: null },
    },
    library: { defaultView: 'grid', defaultSort: 'recent_added' },
    privacy: { confirmExternalLinks: false },
    advanced: { debugLogging: false },
    companion: { textSize: 1 },
    updates: { automaticChecks: true },
    onboarding: { version: 1, status: 'not-started', lastStageAcknowledged: null, completedAt: null },
  };

  it('keeps the shipped fresh-profile defaults exactly', () => {
    expect(DEFAULT_APP_SETTINGS).toStrictEqual(SHIPPED_DEFAULTS);
  });

  it('fills an absent section and an empty one from the same field defaults', () => {
    const minimal = { version: 1, appearance: { palette: 'paper' }, agent: { defaultExecutionMode: 'auto-isolated' } };
    const emptySections = {
      ...minimal,
      reader: {}, layout: {}, ai: { local: {} }, library: {}, privacy: {}, advanced: {}, companion: {}, updates: {}, onboarding: {},
    };
    expect(appSettingsSchema.parse(minimal)).toStrictEqual(SHIPPED_DEFAULTS);
    expect(appSettingsSchema.parse(emptySections)).toStrictEqual(SHIPPED_DEFAULTS);
  });

  it('never shares a defaulted section object between parses', () => {
    const minimal = { version: 1, appearance: { palette: 'paper' }, agent: { defaultExecutionMode: 'auto-isolated' } };
    const first = appSettingsSchema.parse(minimal);
    const second = appSettingsSchema.parse(minimal);
    expect(first.reader).not.toBe(second.reader);
    expect(first.ai.local).not.toBe(second.ai.local);
    expect(first.reader).not.toBe(DEFAULT_APP_SETTINGS.reader);
  });
});
