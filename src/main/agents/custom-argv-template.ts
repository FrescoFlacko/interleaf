import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * Custom agent argv templates.
 *
 * A custom profile's arguments are stored as whole tokens; a token that is
 * exactly a known placeholder is replaced, and nothing is ever handed to a shell.
 */

export type CustomArgvPlaceholderValues = {
  readonly workingDir?: string;
  readonly promptFile?: string;
  readonly sessionId?: string;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
};

/** Replace only whole argv tokens; no shell metacharacters or interpolation are evaluated. */
export function parseArgumentTemplate(
  tokens: readonly string[],
  values: CustomArgvPlaceholderValues,
  options?: { readonly isResume?: boolean },
): readonly string[] {
  return tokens.map((token) => {
    const match = /^\{\{(workingDir|promptFile|sessionId|model|reasoningEffort)\}\}$/u.exec(token);
    if (match !== null) {
      const key = match[1] as keyof CustomArgvPlaceholderValues;
      const rawVal = values[key];
      if (options?.isResume) {
        if (key === 'model' && (rawVal === undefined || rawVal === null || rawVal.trim().length === 0)) {
          throw new InterleafError(
            'validation',
            'The custom resume template requires a model snapshot, but none was recorded for this session.',
          );
        }
        if (key === 'reasoningEffort' && (rawVal === undefined || rawVal === null || rawVal.trim().length === 0)) {
          throw new InterleafError(
            'validation',
            'The custom resume template requires a reasoning effort snapshot, but none was recorded for this session.',
          );
        }
      }
      return rawVal ?? '';
    }
    if (token.includes('{{') || token.includes('}}')) throw new InterleafError('validation', 'Unsupported custom profile placeholder.');
    return token;
  });
}

export function expandCustomArgvTemplate(
  tokens: readonly string[],
  values: CustomArgvPlaceholderValues,
  options?: { readonly isResume?: boolean },
): readonly string[] {
  return parseArgumentTemplate(tokens, values, options);
}
