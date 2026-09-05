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
