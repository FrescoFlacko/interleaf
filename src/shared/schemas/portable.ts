import { z } from 'zod';
import type { PortableValue } from '../models/portable';
import { isAcyclicPortableValue } from '../models/portable-cycle';

/**
 * The shape of portable data, without the cycle check below.
 *
 * Used for the members of a value whose root has already been walked, so the
 * walk happens once per parsed value rather than once per node.
 */
const portableNodeSchema: z.ZodType<PortableValue, PortableValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(portableNodeSchema),
    z.record(z.string(), portableNodeSchema),
  ])
);

/**
 * The runtime counterpart of `PortableValue`.
 *
 * Boundary schemas that accept open-ended data — structured agent event data,
 * diagnostic extras on a stored error — parse it with this schema so the value
 * they hand on is typed as portable rather than as an unconstrained value.
 * Anything `JSON.parse` cannot produce (functions, class instances, symbols,
 * `undefined`) fails here, which is the same set the bounded-value guards
 * already reject. A reference cycle is rejected before the recursive
 * shape above is applied to it.
 */
export const portableValueSchema: z.ZodType<PortableValue, PortableValue> = z
  .custom<PortableValue>(
    // The check runs on the raw input, before the shape above has accepted it.
    // The walk reads only `typeof`, `Array.isArray` and `Object.values` inside a
    // `try`, so it is total on any input and needs no narrower contract; a value
    // that is not portable at all is rejected by the piped shape.
    (value) => isAcyclicPortableValue(value as PortableValue),
    { message: 'Portable data must not contain a reference cycle.' },
  )
  .pipe(portableNodeSchema);
