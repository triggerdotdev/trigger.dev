export function assertExhaustive(x: never): never {
  throw new Error("Unexpected object: " + x);
}

export async function tryCatch<T, E = Error>(
  promise: Promise<T> | undefined
): Promise<[null, T] | [E, null]> {
  if (!promise) {
    return [null, undefined as T];
  }

  try {
    const data = await promise;
    return [null, data];
  } catch (error) {
    return [error as E, null];
  }
}
