import type { ComponentProps, ReactElement } from 'react';
import { AppIcon } from '../AppIcon';
import { cn } from '../ui/cn';

type WholeDocumentChipProps = Omit<ComponentProps<'button'>, 'children'> & {
  /** Whether the whole document is already attached; drawn as a solid chip. */
  readonly attached: boolean;
};

/**
 * "Entire document", shared by Reader Chat and Agent Mode: the same label,
 * glyph and shape in both. Unattached it is a dashed chip with a plus, the
 * "not yet here" shape; attached it is solid and accented, with a check.
 */
export function WholeDocumentChip({ attached, className, type = 'button', ...props }: WholeDocumentChipProps): ReactElement {
  return (
    <button type={type} data-attached={attached ? 'true' : 'false'} className={cn('companion-whole-doc', className)} {...props}>
      <AppIcon name={attached ? 'check' : 'add'} size={12} />
      Entire document
    </button>
  );
}
