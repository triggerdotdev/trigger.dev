/**
 * Object.entries with better type inference
 * @see https://github.com/3x071c/lsg-remix/blob/d1f9317b09edd815487617e2e70f749f9ebe99d0/app/lib/util/entries.ts
 */
export function entries<O extends Record<string, unknown>>(
  obj: O
): {
  readonly [K in keyof O]: [K, O[K]];
}[keyof O][] {
  return Object.entries(obj) as {
    [K in keyof O]: [K, O[K]];
  }[keyof O][];
}
