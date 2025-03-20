export function assertExhaustive(x: never): never {
  throw new Error("Unexpected object: " + x);
}

export async function tryCatch<T, E = Error>(promise: Promise<T>): Promise<[T, null] | [null, E]> {
  try {
    const data = await promise;
    return [data, null];
  } catch (error) {
    return [null, error as E];
  }
}
