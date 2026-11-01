import type { ReactNode } from 'react';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { AppearanceSettingsSection, ReaderSettingsSection, type SettingsSectionProps } from './PreferenceSettingsSections';
import {
  AdvancedSettingsSection,
  GeneralSettingsSection,
  LibrarySettingsSection,
  PrivacySettingsSection,
} from './GeneralSettingsSections';
import {
  CustomProfilesSettingsSection,
  SandboxingSettingsSection,
  WorkingDirectoriesSettingsSection,
} from './AgentSettingsSections';
import type { SettingsSection } from './settings-rail';
import { ThemeSettingsSection } from '../theme/ThemeSettingsSection';
import { AboutUpdatesPanel } from './AboutUpdatesPanel';

type SectionPanelProps = SettingsSectionProps & {
  readonly availableProfiles: readonly AgentProfile[];
  readonly workingDirectories: readonly AgentWorkingDirectory[];
};

/** Every section except AI Providers, which the dialog renders with its rows. */
const SECTION_PANELS: Readonly<Record<Exclude<SettingsSection, 'ai'>, (props: SectionPanelProps) => ReactNode>> = {
  reader: (props) => <ReaderSettingsSection settings={props.settings} onChange={props.onChange} />,
  theme: (props) => <ThemeSettingsSection settings={props.settings} onChange={props.onChange} />,
  appearance: (props) => <AppearanceSettingsSection settings={props.settings} onChange={props.onChange} />,
  'custom-profiles': () => <CustomProfilesSettingsSection />,
  'working-directories': (props) => <WorkingDirectoriesSettingsSection {...props} />,
  general: (props) => <GeneralSettingsSection settings={props.settings} onChange={props.onChange} />,
  library: (props) => <LibrarySettingsSection settings={props.settings} onChange={props.onChange} />,
  privacy: (props) => <PrivacySettingsSection settings={props.settings} onChange={props.onChange} />,
  advanced: (props) => <AdvancedSettingsSection settings={props.settings} onChange={props.onChange} />,
  sandboxing: (props) => <SandboxingSettingsSection settings={props.settings} onChange={props.onChange} />,
  about: (props) => <AboutUpdatesPanel settings={props.settings} onChange={props.onChange} />,
};

export function SettingsSectionPanel({ section, ...props }: SectionPanelProps & {
  readonly section: Exclude<SettingsSection, 'ai'>;
}) {
  return SECTION_PANELS[section](props);
}
