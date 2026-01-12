declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
type Branded<T, B> = T & Brand<B>;

export type IdempotencyKey = Branded<string, "IdempotencyKey">;

export type IdempotencyKeyScope = "run" | "attempt" | "global";

/**
 * An object containing the idempotency key hash along with the original user-provided key and scope.
 * This is returned by `idempotencyKeys.create()` to preserve the original key material.
 */
export type IdempotencyKeyInfo = {
  /** The hashed idempotency key used for deduplication */
  hash: IdempotencyKey;
  /** The original user-provided key material */
  userKey: string | string[];
  /** The scope used when creating this key */
  scope: IdempotencyKeyScope;
};

/** Symbol used to identify IdempotencyKeyInfo objects at runtime */
const idempotencyKeyInfoSymbol = Symbol.for("trigger.dev/idempotencyKeyInfo");

/**
 * Type guard to check if a value is an IdempotencyKeyInfo object
 */
export function isIdempotencyKeyInfo(value: unknown): value is IdempotencyKeyInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    idempotencyKeyInfoSymbol in value &&
    (value as any)[idempotencyKeyInfoSymbol] === true
  );
}

/**
 * Creates an IdempotencyKeyInfo object with the runtime marker
 */
export function createIdempotencyKeyInfo(
  hash: IdempotencyKey,
  userKey: string | string[],
  scope: IdempotencyKeyScope
): IdempotencyKeyInfo {
  return {
    hash,
    userKey,
    scope,
    [idempotencyKeyInfoSymbol]: true,
  } as IdempotencyKeyInfo;
}
