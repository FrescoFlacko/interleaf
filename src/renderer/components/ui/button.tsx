import type { ComponentProps, ReactElement } from 'react';
import { variants, type VariantProps } from './cn';

/**
 * The themed focus ring, used by every control that sits on a themed surface.
 * It lives on the variants rather than the base because `cn` does not resolve
 * conflicting utilities, so the one variant that needs a different ring has to
 * be the only source of a ring colour for its own selection.
 */
const THEMED_FOCUS = 'focus-visible:ring-2 focus-visible:ring-focus-ring';

/**
 * The cover-safe focus ring: a white band with a near-black band just inside
 * it. A single-colour indicator can vanish against a cover image that happens
 * to match it, whereas one of these two bands always contrasts with whatever
 * artwork is underneath. `COVER_SAFE_FOCUS` is expressed as ring plus shadow so
 * both bands paint outside the control's own background.
 */
const COVER_SAFE_FOCUS =
  'focus-visible:ring-2 focus-visible:ring-white ' +
  'focus-visible:shadow-[0_0_0_4px_rgba(10,10,12,0.92)]';

const buttonVariants = variants(
  // `ui-press` (styles/motion.css) owns the transition list and the 0.97
  // press scale, so every button gives the same feedback.
  'ui-press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
    'focus-visible:outline-none ' +
    'disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      variant: {
        /** Filled call to action; the 6a Start and 6b Resume buttons. */
        primary: `bg-accent text-on-accent hover:opacity-90 ${THEMED_FOCUS}`,
        /** Hairline-bordered secondary control; Choose…, review actions. */
        outline: `border border-border-subtle bg-bg-primary text-text-primary hover:bg-bg-surface ${THEMED_FOCUS}`,
        /** Borderless control that only tints on hover. */
        ghost: `text-text-secondary hover:bg-bg-surface hover:text-text-primary ${THEMED_FOCUS}`,
        /** The ghost control in accent text, for the one emphasised action in a ghost row. */
        'ghost-accent': `text-accent hover:bg-bg-surface ${THEMED_FOCUS}`,
        /** Inline textual affordance; Manage directories, Show, Collapse. */
        link: `rounded-sm text-accent underline-offset-2 hover:underline ${THEMED_FOCUS}`,
        /** Destructive secondary control; Discard sandbox, Stop. */
        danger: `border border-border-subtle bg-bg-primary text-danger hover:bg-danger/10 ${THEMED_FOCUS}`,
        /**
         * Control painted over artwork, such as the library card's ellipsis.
         * Its colours are fixed rather than themed because the surface beneath
         * is an arbitrary cover image, not a themed background.
         */
        overlay: `bg-white/20 text-white backdrop-blur-[2px] hover:bg-white/35 ${COVER_SAFE_FOCUS}`,
      },
      size: {
        /** 28 px chip, the companion's compact control height. */
        chip: 'h-7 px-3 text-xs',
        /** 32 px with compact text; Send and Resume. */
        sm: 'h-8 px-3 text-xs',
        /** 32 px, the default button height. */
        md: 'h-8 px-3 text-sm',
        /** 36 px, a primary composer action such as Start. */
        lg: 'h-9 px-4 text-sm',
        /** Text-only; the control brings its own box. */
        inline: 'text-xs',
        /** 28 px square icon-only control. */
        icon: 'size-7 p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  }
);

/** `ComponentProps` rather than `ButtonHTMLAttributes` so React 19's ref-as-prop typechecks. */
export type ButtonProps = ComponentProps<'button'> &
  VariantProps<{
    variant: Record<'primary' | 'outline' | 'ghost' | 'ghost-accent' | 'link' | 'danger' | 'overlay', string>;
    size: Record<'chip' | 'sm' | 'md' | 'lg' | 'inline' | 'icon', string>;
  }>;

/**
 * shadcn-shaped button. `type` defaults to `button` so a control inside a form
 * never submits it by accident.
 */
export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps): ReactElement {
  return <button type={type} className={buttonVariants({ variant, size, className })} {...props} />;
}
