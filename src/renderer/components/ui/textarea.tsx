import type { TextareaHTMLAttributes, ReactElement } from 'react';
import { cn } from './cn';

/**
 * shadcn-shaped textarea. The reference draws the border on the surrounding
 * card, so the field itself is borderless and inherits the card's background.
 */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return (
    <textarea
      className={cn(
        'w-full resize-none border-0 bg-transparent p-0 text-text-primary',
        'placeholder:text-text-secondary focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
