import type { SettingsRailId } from '../../stores/use-ui-store';

/** The panel a rail entry shows. */
export type SettingsSection =
  | 'general'
  | 'reader'
  | 'theme'
  | 'appearance'
  | 'library'
  | 'ai'
  | 'custom-profiles'
  | 'working-directories'
  | 'sandboxing'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsRailEntry = {
  readonly id: SettingsRailId;
  readonly label: string;
  readonly section: SettingsSection;
};

/**
 * The Settings navigation rail.
 *
 * There is one Settings dialog, and this list is the whole of its navigation.
 * Built-in agent profiles no longer have a rail entry of their own: each one is
 * edited inside the AI Providers row for the provider that runs it, so the
 * dialog has exactly one editor per profile. Custom profiles, working
 * directories and sandboxing keep their own named entries.
 */
export const SETTINGS_RAIL: readonly SettingsRailEntry[] = [
  { id: 'general', label: 'General', section: 'general' },
  { id: 'reader', label: 'Reader', section: 'reader' },
  { id: 'theme', label: 'Theme', section: 'theme' },
  { id: 'appearance', label: 'Appearance', section: 'appearance' },
  { id: 'library', label: 'Library', section: 'library' },
  { id: 'ai', label: 'AI Providers', section: 'ai' },
  { id: 'custom-profiles', label: 'Custom Profiles', section: 'custom-profiles' },
  { id: 'working-directories', label: 'Agent Working Directories', section: 'working-directories' },
  { id: 'sandboxing', label: 'Agent Sandboxing', section: 'sandboxing' },
  { id: 'privacy', label: 'Privacy', section: 'privacy' },
  { id: 'advanced', label: 'Advanced', section: 'advanced' },
  { id: 'about', label: 'About & Updates', section: 'about' },
];

const DEFAULT_ENTRY: SettingsRailEntry = { id: 'ai', label: 'AI Providers', section: 'ai' };

/**
 * The entry a deep link names, falling back to the dialog's default section.
 * A legacy `profiles` link no longer matches an entry and therefore lands on
 * AI Providers, where those settings now live.
 */
export function settingsRailEntry(id: SettingsRailId): SettingsRailEntry {
  return SETTINGS_RAIL.find((entry) => entry.id === id) ?? DEFAULT_ENTRY;
}

/** Provider that used to own the standalone built-in profile editor. */
const DEFAULT_BUILT_IN_PROFILE_ID = 'codex';

/**
 * Provider row a deep link opens in the accordion, or `null` when the link does
 * not open the AI Providers section at all. A legacy `profiles` link opens the
 * built-in provider whose profile the old page showed first; an `ai:<row>`
 * link opens that row; an ordinary AI Providers link opens the API provider,
 * as in design 5a.
 */
export function settingsRailProviderId(id: SettingsRailId): string | null {
  const linked = linkedProviderRowId(id);
  if (linked !== null) return linked;
  return settingsRailEntry(id).section === 'ai' ? 'openrouter' : null;
}

/** Row named by the link itself: the legacy `profiles` link or an `ai:<row>` link. */
function linkedProviderRowId(id: SettingsRailId): string | null {
  if (id === 'profiles') return DEFAULT_BUILT_IN_PROFILE_ID;
  return id.startsWith('ai:') ? id.slice('ai:'.length) : null;
}

/** Whether a rail entry describes what is currently shown. */
export function isSettingsRailEntryActive(entry: SettingsRailEntry, activeSection: SettingsSection): boolean {
  return entry.section === activeSection;
}
