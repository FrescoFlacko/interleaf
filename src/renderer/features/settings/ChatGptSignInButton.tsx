import type { ReactElement } from 'react';
import { Button } from '../../components/ui/button';

/**
 * Pending indicator for the sign-in call to action. It is hidden from assistive
 * technology because the button's own label and the adjacent status region
 * already carry the waiting state, and it stops animating under reduced motion
 * while remaining a visible ring.
 */
function SignInSpinner(): ReactElement {
  return (
    <svg
      data-testid="sign-in-chatgpt-spinner"
      className="size-3.5 animate-spin motion-reduce:animate-none"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type ChatGptSignInButtonProps = {
  /** True while the main-owned browser sign-in flow is still running. */
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onSignIn: () => void;
};

/**
 * Primary sign-in call to action for the ChatGPT subscription. Sign-in itself
 * stays in main; this control only reports the pending state it is given.
 */
export function ChatGptSignInButton({ pending, disabled, onSignIn }: ChatGptSignInButtonProps): ReactElement {
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        data-testid="sign-in-chatgpt-button"
        onClick={onSignIn}
        disabled={disabled}
        aria-busy={pending}
      >
        {pending && <SignInSpinner />}
        {pending ? 'Opening ChatGPT sign-in…' : 'Sign in with ChatGPT'}
      </Button>
      {/* The live region stays mounted and empty while idle: a region inserted
          at the same moment its text appears is not reliably announced. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="chatgpt-sign-in-pending-status">
        {pending ? 'Opening the ChatGPT sign-in page in your browser. Complete sign-in there, then return to Interleaf.' : ''}
      </span>
    </>
  );
}
