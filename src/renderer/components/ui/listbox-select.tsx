import { useId, useRef, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AppIcon } from '../AppIcon';
import { cn } from './cn';
import type { SelectOption } from './select-model';
import { useSelectState } from './use-select-state';
import { useAnchoredPosition } from './use-anchored-position';
import { MENU_CHECK_SLOT_CLASS, MENU_SURFACE_CLASS, phaseAttributes, usePopoverPresence } from './popover-presence';
import type { SlidePhase } from '../slide-presence';

export type SelectProps<V extends string> = {
  readonly value: V;
  readonly options: readonly SelectOption<V>[];
  readonly onValueChange: (value: V) => void;
  readonly id?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly 'aria-labelledby'?: string | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly 'data-testid'?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  /** Shown when the value matches no option. */
  readonly placeholder?: string | undefined;
  readonly className?: string | undefined;
  readonly wrapperClassName?: string | undefined;
  /**
   * Chip or caption drawn inside the field, left of the caret, as the
   * reference does with `RECOMMENDED`. Decorative; the box stays one target.
   */
  readonly trailing?: ReactNode;
  /**
   * `field` is the boxed form control; `inline` the borderless header chip;
   * `chip` the companion picker chip Reader Chat's menus also use.
   */
  readonly variant?: 'field' | 'inline' | 'chip';
  /** Field height and type: `sm` for toolbars and popovers. */
  readonly size?: 'default' | 'sm';
};

const TRIGGER_VARIANTS = {
  field: 'w-full rounded-md border border-border-strong bg-bg-primary pl-3 text-text-primary hover:bg-bg-surface',
  inline: 'rounded-sm px-1 py-0.5 text-xs text-text-secondary hover:text-text-primary',
  chip: 'companion-picker',
} as const;

const FIELD_SIZES = { default: 'h-9 text-sm', sm: 'h-8 text-xs' } as const;

/**
 * Custom select-only combobox (WAI-ARIA APG pattern). DOM focus stays on the
 * trigger; the open list is tracked with `aria-activedescendant`, so dialog
 * focus traps never see focus leave the control. The list is portalled to the
 * enclosing dialog (or the body) and anchored to the trigger, so scrolling
 * and clipping ancestors cannot cut it off, and it is drawn with the palette
 * tokens in every theme — unlike the platform popup, which ignores them.
 */
export function Select<V extends string>(props: SelectProps<V>): ReactElement {
  const { value, options, variant = 'field', size = 'default', trailing } = props;
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const state = useSelectState({ value, options, onValueChange: props.onValueChange, triggerRef });
  const presence = usePopoverPresence(state.open);
  const selected = options.find((option) => option.value === value);
  const optionId = (index: number): string => `${listId}-option-${String(index)}`;

  return (
    <span className={cn('relative flex min-w-0 items-center', variant === 'inline' && 'inline-flex shrink-0', variant === 'chip' && 'inline-flex max-w-full', props.wrapperClassName)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={props.id}
        data-testid={props['data-testid']}
        data-value={value}
        title={props.title}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid']}
        aria-haspopup="listbox"
        aria-expanded={state.open}
        aria-controls={state.open ? listId : undefined}
        aria-activedescendant={state.open && state.active >= 0 ? optionId(state.active) : undefined}
        onClick={state.toggle}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { state.handleKeyDown(event); }}
        onBlur={state.close}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
          TRIGGER_VARIANTS[variant],
          variant === 'field' && FIELD_SIZES[size],
          variant === 'field' && (trailing === undefined ? 'pr-8' : 'pr-16'),
          props.className
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? props.placeholder ?? value}</span>
        {variant !== 'field' && <AppIcon name="menu-caret" size={variant === 'chip' ? 12 : 13} />}
      </button>
      {variant === 'field' && (
        <span className="pointer-events-none absolute right-2.5 flex items-center gap-1.5 text-text-secondary">
          {trailing}
          <AppIcon name="menu-caret" size={13} />
        </span>
      )}
      {presence.present && (
        <SelectList
          phase={presence.phase}
          listId={listId}
          listRef={listRef}
          triggerRef={triggerRef}
          label={props['aria-label']}
          labelledBy={props['aria-labelledby'] ?? props.id}
          options={options}
          value={value}
          active={state.active}
          minWidth={state.minWidth}
          optionId={optionId}
          onActivate={state.setActive}
          onCommit={state.commit}
        />
      )}
    </span>
  );
}

type SelectListProps<V extends string> = {
  readonly phase: SlidePhase;
  readonly listId: string;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly label: string | undefined;
  readonly labelledBy: string | undefined;
  readonly options: readonly SelectOption<V>[];
  readonly value: V;
  readonly active: number;
  readonly minWidth: number;
  readonly optionId: (index: number) => string;
  readonly onActivate: (index: number) => void;
  readonly onCommit: (index: number) => void;
};

function SelectList<V extends string>(props: SelectListProps<V>): ReactElement {
  const anchorStyle = useAnchoredPosition(props.triggerRef, props.listRef, 'bottom-start');
  const host = props.triggerRef.current?.closest('[role="dialog"]') ?? document.body;
  return createPortal(
    <div
      ref={props.listRef}
      id={props.listId}
      role="listbox"
      // A list fading out is hidden from assistive technology and names nothing.
      aria-label={props.phase === 'exiting' ? undefined : props.label}
      aria-labelledby={props.label === undefined && props.phase !== 'exiting' ? props.labelledBy : undefined}
      // Keep focus on the trigger: a press on the list must not blur it.
      onMouseDown={(event) => { event.preventDefault(); }}
      {...phaseAttributes(props.phase)}
      style={{ ...anchorStyle, minWidth: `${String(props.minWidth)}px` }}
      className={cn(MENU_SURFACE_CLASS, 'fixed z-[70] max-h-[min(18rem,calc(100vh-16px))] max-w-[min(28rem,calc(100vw-16px))] overflow-y-auto')}
    >
      {props.options.map((option, index) => (
        <div
          key={option.value}
          id={props.optionId(index)}
          role="option"
          aria-labelledby={`${props.optionId(index)}-label`}
          aria-describedby={option.description === undefined ? undefined : `${props.optionId(index)}-description`}
          aria-selected={option.value === props.value}
          aria-disabled={option.disabled === true ? true : undefined}
          data-active={index === props.active ? 'true' : undefined}
          data-value={option.value}
          onClick={() => { props.onCommit(index); }}
          onMouseMove={() => { props.onActivate(index); }}
          className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm text-text-primary
            data-[active=true]:bg-accent-muted aria-disabled:cursor-not-allowed aria-disabled:text-text-secondary"
        >
          <span aria-hidden="true" className={cn(MENU_CHECK_SLOT_CLASS, 'mt-1')}>
            {option.value === props.value && <AppIcon name="check" size={12} />}
          </span>
          {option.leading !== undefined && <span aria-hidden="true" className="mt-0.5 flex shrink-0">{option.leading}</span>}
          <span className="min-w-0 flex-1">
            <span id={`${props.optionId(index)}-label`} className="flex items-center gap-1.5">
              <span className="truncate">{option.label}</span>
              {option.badge}
            </span>
            {option.description !== undefined && (
              <span id={`${props.optionId(index)}-description`} className="block text-xs text-text-secondary">{option.description}</span>
            )}
          </span>
        </div>
      ))}
    </div>,
    host
  );
}
