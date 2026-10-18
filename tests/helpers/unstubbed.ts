/**
 * A complete stand-in for a main-process collaborator whose class carries
 * private state, so an object literal cannot satisfy its type.
 *
 * Every member is present: the ones a test supplies answer as written, and any
 * other member throws when it is read, naming itself. A test that reaches a
 * collaborator it did not expect therefore fails loudly instead of observing a
 * silent `undefined`. `then` and symbol keys read as absent so the double is
 * not mistaken for a promise or an iterable.
 */
export function unstubbed<T extends object>(name: string, stubs: Partial<T> = {}): T {
  return new Proxy(stubs, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (Object.hasOwn(target, property)) return Reflect.get(target, property, receiver);
      throw new Error(`The test did not stub ${name}.${property}.`);
    },
  }) as T;
}
