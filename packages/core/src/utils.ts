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

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
};

export function promiseWithResolvers<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
