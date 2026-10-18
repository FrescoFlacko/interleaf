/**
 * Repo-local stand-in for shadcn/ui's `cn` helper and `class-variance-authority`.
 *
 * The canonical shadcn layer depends on `clsx`, `tailwind-merge` and `cva`.
 * Those packages cannot be added here: `scripts/quality/policy.py` hashes
 * `package.json` and `package-lock.json` into the frozen gate identity, so any
 * dependency change fails the mandatory quality check. The two behaviours the
 * primitives in this folder actually rely on — conditional class joining and
 * variant lookup — are reproduced below.
 *
 * Unlike `tailwind-merge`, `cn` does not resolve conflicting Tailwind
 * utilities: the *last* class simply wins in CSS source order, not in argument
 * order. Call sites must therefore vary a control through its `variant` /
 * `size` props rather than by passing a conflicting override in `className`.
 */

export type ClassValue = string | number | null | undefined | false | readonly ClassValue[];

export function cn(...values: readonly ClassValue[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === '') continue;
    if (Array.isArray(value)) {
      const nested = cn(...(value as readonly ClassValue[]));
      if (nested !== '') parts.push(nested);
      continue;
    }
    parts.push(String(value));
  }
  return parts.join(' ');
}

type VariantGroups = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The selected key for each variant group, all optional. */
export type VariantProps<TGroups extends VariantGroups> = {
  readonly [K in keyof TGroups]?: keyof TGroups[K] | undefined;
};

type VariantConfig<TGroups extends VariantGroups> = {
  readonly variants: TGroups;
  readonly defaultVariants: { readonly [K in keyof TGroups]: keyof TGroups[K] };
};

/**
 * Minimal `cva` equivalent: a base class string plus named variant groups,
 * each with a required default so a selection is always resolvable.
 */
export function variants<TGroups extends VariantGroups>(
  base: string,
  config: VariantConfig<TGroups>
): (props?: VariantProps<TGroups> & { readonly className?: string | undefined }) => string {
  return (props) => {
    // Both sides are read as plain key lookups: a group name maps to the key
    // chosen for that group, which is a `keyof` of the group's class table.
    const requested: Readonly<Record<string, PropertyKey | undefined>> = props ?? {};
    const defaults: Readonly<Record<string, PropertyKey>> = config.defaultVariants;
    const selected: string[] = [];
    for (const [group, choices] of Object.entries<Readonly<Record<string, string>>>(config.variants)) {
      const key = requested[group] ?? defaults[group];
      const value = typeof key === 'string' ? choices[key] : undefined;
      if (value !== undefined) selected.push(value);
    }
    return cn(base, ...selected, props?.className);
  };
}
