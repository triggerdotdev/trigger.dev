export type IdempotencyKeyScope = "run" | "attempt" | "global";

export type IdempotencyKeyOptions = {
  key: string;
  scope: IdempotencyKeyScope;
};

export interface IdempotencyKeyCatalog {
  registerKeyOptions(hash: string, options: IdempotencyKeyOptions): void;
  getKeyOptions(hash: string): IdempotencyKeyOptions | undefined;
}
