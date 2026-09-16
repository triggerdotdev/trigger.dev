export function assertExhaustive(x: never): never {
  throw new Error("Unexpected object: " + x);
}

const NON_ASCII_SEARCH_CHAR = /^[\p{L}\p{N}]$/u;

function isSearchChar(code: number, text: string, index: number, length: number): boolean {
  if (code < 128) {
    return (
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      code === 95 || // _
      code === 46 || // .
      code === 47 || // /
      code === 58 || // :
      code === 64 || // @
      code === 43 || // +
      code === 45 // -
    );
  }
  return NON_ASCII_SEARCH_CHAR.test(text.slice(index, index + length));
}

/**
 * Lowercases, collapses each run of characters outside [\p{L}\p{N}_./:@+-] to a single space,
 * and strips spaces adjacent to ":". Single-pass; the equivalent two-regex form is ~4x slower
 * on multi-KB inputs and this runs in the ingest hot path.
 */
export function normalizeSearchText(value: string): string {
  const text = value.toLowerCase();
  const parts: string[] = [];
  let runStart = -1;
  let gap = false;

  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const length = code > 0xffff ? 2 : 1;

    if (isSearchChar(code, text, i, length)) {
      if (runStart === -1) {
        if (gap && code !== 58) parts.push(" ");
        gap = false;
        runStart = i;
      }
    } else {
      if (runStart !== -1) {
        parts.push(text.slice(runStart, i));
        runStart = -1;
      }
      gap = true;
    }

    i += length;
  }

  if (runStart !== -1) {
    if (gap) parts.push(" ");
    parts.push(text.slice(runStart));
  } else if (gap) {
    parts.push(" ");
  }

  let out = "";
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (part === " " && k > 0 && parts[k - 1]!.endsWith(":")) continue;
    out += part;
  }
  return out;
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
