import { z } from "zod/v4";

/**
 * Preserve the Zod 4.0-compatible declaration shape while using newer Zod 4
 * implementations at runtime. Newer releases infer the discriminator as a
 * second type parameter, which older `zod/v4` permalinks cannot consume.
 */
export type CompatibleZodDiscriminatedUnion<
  Types extends readonly [z.ZodTypeAny, ...z.ZodTypeAny[]],
> = z.ZodDiscriminatedUnion<Types>;

export function discriminatedUnion<const Types extends readonly [z.ZodTypeAny, ...z.ZodTypeAny[]]>(
  discriminator: string,
  options: Types
): CompatibleZodDiscriminatedUnion<Types> {
  return z.discriminatedUnion(
    discriminator,
    options as any
  ) as CompatibleZodDiscriminatedUnion<Types>;
}

/**
 * Same declaration-compat trick for `z.preprocess`: newer Zod 4 releases
 * declare its result as `ZodPreprocess`, which older `zod/v4` permalinks do
 * not export. Erase it to the portable `ZodType` shape in declarations.
 */
export function preprocess<T extends z.ZodTypeAny>(
  fn: (value: unknown) => unknown,
  schema: T
): z.ZodType<z.output<T>, unknown> {
  return z.preprocess(fn, schema) as unknown as z.ZodType<z.output<T>, unknown>;
}
