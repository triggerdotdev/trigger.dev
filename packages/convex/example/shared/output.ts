import { z } from "zod";
import { VARIANTS } from "./catalog";

export const outputSchema = z.object({
  inputBytes: z.number().int().positive(),
  processingMs: z.number().nonnegative(),
  variants: z
    .array(
      z.object({
        kind: z.enum(["hero", "card", "square"]),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        bytes: z.number().int().positive(),
        format: z.literal("avif"),
      })
    )
    .length(3)
    .refine(
      (variants) =>
        VARIANTS.every((expected) =>
          variants.some(
            (actual) =>
              actual.kind === expected.kind &&
              actual.width === expected.width &&
              actual.height === expected.height
          )
        ),
      "Unexpected image crop set"
    ),
});
