type Index<T = any> = { [key: string]: T };
type KeyValueGenerator<K, V, R> = (key: K, value: V, accum: Index<R>) => Index<R> | null;
type ArrayKeyValueGenerator<T, R> = KeyValueGenerator<T, number, R>;
type ObjectKeyValueGenerator<T, R> = KeyValueGenerator<string, T, R>;

export function keyValueBy<T>(arr: T[]): Index<true>;
export function keyValueBy<T, R>(
  arr: T[],
  keyValue: KeyValueGenerator<T, number, R>,
  initialValue?: Index<R>
): Index<R>;
export function keyValueBy<T, R>(
  obj: Index<T>,
  keyValue: KeyValueGenerator<string, T, R>,
  initialValue?: Index<R>
): Index<R>;

/** Generates an object from an array or object. Simpler than reduce or _.transform. The KeyValueGenerator passes (key, value) if the input is an object, and (value, i) if it is an array. The return object from each iteration is merged into the accumulated object. Return null to skip an item. */
export function keyValueBy<T, R = true>(
  input: T[] | Index<T>,
  // if no keyValue is given, sets all values to true
  keyValue?: ArrayKeyValueGenerator<T, R> | ObjectKeyValueGenerator<T, R>,
  accum: Index<R> = {}
): Index<R> {
  const isArray = Array.isArray(input);
  keyValue =
    keyValue || ((key: T): Index<R> => ({ [key as unknown as string]: true as unknown as R }));
  // considerably faster than Array.prototype.reduce
  Object.entries(input || {}).forEach(([key, value], i) => {
    const o = isArray
      ? (keyValue as ArrayKeyValueGenerator<T, R>)(value, i, accum)
      : (keyValue as ObjectKeyValueGenerator<T, R>)(key, value, accum);
    Object.entries(o || {}).forEach((entry) => {
      accum[entry[0]] = entry[1];
    });
  });

  return accum;
}
