import {
  COMPANION_TEXT_SIZE_MAX,
  COMPANION_TEXT_SIZE_MIN,
  COMPANION_TEXT_SIZE_STEP,
  normalizeCompanionTextSize,
  type AppSettings,
} from '@shared/schemas/settings';
import { useUiStore } from '../../stores/use-ui-store';
import { useReaderStore } from '../../stores/use-reader-store';
import { companionTextSizeLabel } from '../../components/companion-text-size-label';
import { Select } from '../../components/ui/select';
import type { SelectOption } from '../../components/ui/select-model';
import { SettingsSectionHeader } from '../../components/ui/settings-section-header';

const FONT_FAMILY_OPTIONS: readonly SelectOption<AppSettings['reader']['fontFamily']>[] = [
  { value: 'system', label: 'System' },
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans serif' },
  { value: 'dyslexic', label: 'OpenDyslexic-compatible' },
];

/** The settings document a section edits, and where its edits go. */
export type SettingsSectionProps = {
  readonly settings: AppSettings;
  readonly onChange: (next: AppSettings) => void;
};

type ReflowAppearance = Parameters<ReturnType<typeof useReaderStore.getState>['setReaderAppearance']>[0];

export function ReaderSettingsSection({ settings, onChange }: SettingsSectionProps) {
  const setReaderAppearance = useReaderStore((state) => state.setReaderAppearance);
  /** Saves a reflow preference and applies it to the open document at once. */
  const applyReflow = (reader: Partial<AppSettings['reader']>, appearance: ReflowAppearance): void => {
    onChange({ ...settings, reader: { ...settings.reader, ...reader } });
    void setReaderAppearance(appearance);
  };

  return (
    <section aria-labelledby="settings-reader-heading">
      <SettingsSectionHeader id="settings-reader-heading" title="Reader" description="Reflow controls apply to EPUB, MOBI, and DOCX. PDF uses its native layout and zoom." />
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-text-secondary">Font size
          <input data-testid="settings-reader-font-size" type="range" min="0.75" max="2" step="0.05" value={settings.reader.fontSize} onChange={(e) => { const value = Number(e.target.value); applyReflow({ fontSize: value }, { reflowFontSize: value }); }} className="mt-2 w-full accent-accent" />
          <output className="text-text-primary">{Math.round(settings.reader.fontSize * 100)}%</output>
        </label>
        <label className="text-xs text-text-secondary">Font family
          <Select aria-label="Font family" data-testid="settings-reader-font-family" value={settings.reader.fontFamily} options={FONT_FAMILY_OPTIONS} onValueChange={(fontFamily) => { applyReflow({ fontFamily }, { reflowFontFamily: fontFamily }); }} wrapperClassName="mt-2" />
        </label>
        <label className="text-xs text-text-secondary">Line spacing
          <input data-testid="settings-reader-line-spacing" type="range" min="1.2" max="2.2" step="0.05" value={settings.reader.lineSpacing} onChange={(e) => { const value = Number(e.target.value); applyReflow({ lineSpacing: value }, { reflowLineHeight: value }); }} className="mt-2 w-full accent-accent" />
          <output className="text-text-primary">{settings.reader.lineSpacing.toFixed(2)}</output>
        </label>
        <label className="text-xs text-text-secondary">Content width
          <input data-testid="settings-reader-content-width" type="range" min="40" max="100" step="1" value={settings.reader.contentWidth} onChange={(e) => { const value = Number(e.target.value); applyReflow({ contentWidth: value }, { reflowContentWidth: value }); }} className="mt-2 w-full accent-accent" />
          <output className="text-text-primary">{settings.reader.contentWidth}%</output>
        </label>
        <label className="text-xs text-text-secondary">Paragraph spacing
          <input data-testid="settings-reader-paragraph-spacing" type="range" min="0" max="3" step="0.1" value={settings.reader.paragraphSpacing} onChange={(e) => { const value = Number(e.target.value); applyReflow({ paragraphSpacing: value }, { reflowParagraphSpacing: value }); }} className="mt-2 w-full accent-accent" />
          <output className="text-text-primary">{settings.reader.paragraphSpacing.toFixed(1)}em</output>
        </label>
        <label className="text-xs text-text-secondary">Page margins
          <input data-testid="settings-reader-page-margin" type="range" min="0.75" max="5" step="0.25" value={settings.reader.pageMargin} onChange={(e) => { const value = Number(e.target.value); applyReflow({ pageMargin: value }, { reflowHorizontalMarginRem: value }); }} className="mt-2 w-full accent-accent" />
          <output className="text-text-primary">{settings.reader.pageMargin.toFixed(2)}rem</output>
        </label>
      </div>
    </section>
  );
}

export function AppearanceSettingsSection({ settings, onChange }: SettingsSectionProps) {
  return (
    <section aria-labelledby="settings-appearance-heading">
      <SettingsSectionHeader id="settings-appearance-heading" title="Appearance" description="Text size for the companion column. Colour themes are under Theme." />
      {/* The companion column's own readable-text size. A reader who has
          already set the document's text size looks here next. This is the
          preference's only control. */}
      <label className="block text-xs text-text-secondary" htmlFor="settings-companion-text-size">Chat and Agent text size
        <input
          id="settings-companion-text-size"
          data-testid="settings-companion-text-size"
          type="range"
          min={COMPANION_TEXT_SIZE_MIN}
          max={COMPANION_TEXT_SIZE_MAX}
          step={COMPANION_TEXT_SIZE_STEP}
          value={settings.companion.textSize}
          onChange={(event) => {
            const textSize = normalizeCompanionTextSize(Number(event.target.value));
            onChange({ ...settings, companion: { ...settings.companion, textSize } });
            useUiStore.getState().setCompanionTextSize(textSize);
          }}
          className="mt-2 w-full accent-accent"
        />
        <output className="text-text-primary">{companionTextSizeLabel(settings.companion.textSize)}</output>
      </label>
      <p className="mt-1 text-2xs leading-relaxed text-text-secondary">Applies to the readable text in Chat and Agent — transcripts, agent activity, and both composers. Controls, icons and the document keep their own sizes.</p>
    </section>
  );
}
