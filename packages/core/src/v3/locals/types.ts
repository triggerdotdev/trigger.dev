declare const __local: unique symbol;
type BrandLocal<T> = { [__local]: T };

// Create a type-safe store for your locals
export type LocalsKey<T> = BrandLocal<T> & {
  readonly id: string;
  readonly __type: unique symbol;
};

export interface LocalsManager {
  createLocal<T>(id: string): LocalsKey<T>;
  getLocal<T>(key: LocalsKey<T>): T | undefined;
  setLocal<T>(key: LocalsKey<T>, value: T): void;
}
