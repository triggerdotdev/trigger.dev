/**
 * A type-safe key for `locals`. Carries the value type `T` as a phantom
 * marker on the optional `__valueType` field so two keys with different
 * value types are distinguishable at the type level.
 *
 * The phantom field is intentionally not anchored to a `unique symbol`:
 * dual-package builds (`tshy`) emit separate `.d.ts` files for ESM and
 * CJS outputs, and each `unique symbol` declaration in a `.d.ts` is its
 * own nominal type. If a single compilation ever resolves `LocalsKey`
 * from both the ESM and CJS paths — which happens under certain pnpm
 * hoisting layouts — `unique symbol` brands produce structurally
 * incompatible variants of the same type. A plain string brand avoids
 * the hazard.
 */
export type LocalsKey<T> = {
  readonly id: string;
  readonly __type: symbol;
  /** Phantom carrier for the value type — never read at runtime. */
  readonly __valueType?: T;
};

export interface LocalsManager {
  createLocal<T>(id: string): LocalsKey<T>;
  getLocal<T>(key: LocalsKey<T>): T | undefined;
  setLocal<T>(key: LocalsKey<T>, value: T): void;
}
