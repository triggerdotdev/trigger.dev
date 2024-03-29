export type RequireKeys<T extends object, K extends keyof T> = Required<Pick<T, K>> &
  Omit<T, K> extends infer O
  ? { [P in keyof O]: O[P] }
  : never;

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
