import type { ReactElement, ReactNode } from 'react';

type SettingsSectionHeaderProps = {
  /** Id of the heading; the section names itself with `aria-labelledby`. */
  readonly id: string;
  readonly title: string;
  readonly description?: ReactNode;
  /** A control aligned to the heading's end, such as "Add provider". */
  readonly action?: ReactNode;
};

/**
 * The one heading treatment every Settings section uses: title, an optional
 * one-paragraph description and an optional trailing action, on the same
 * type scale and spacing everywhere.
 */
export function SettingsSectionHeader({ id, title, description, action }: SettingsSectionHeaderProps): ReactElement {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <div className="mr-auto flex min-w-0 max-w-xl flex-col gap-1">
        <h3 id={id} className="settings-section-title">{title}</h3>
        {description !== undefined && <p className="settings-section-sub">{description}</p>}
      </div>
      {action}
    </div>
  );
}
