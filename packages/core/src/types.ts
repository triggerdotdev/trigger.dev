// See this for more: https://twitter.com/mattpocockuk/status/1653403198885904387?s=20
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export interface AsyncMap {
  get: (key: string) => Promise<any>;
  set: (key: string, value: any) => Promise<any>;
  delete: (key: string) => Promise<boolean>;
}
