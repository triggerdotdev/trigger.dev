declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
type Branded<T, B> = T & Brand<B>;

export type IdempotencyKey = Branded<string, "IdempotencyKey">;
