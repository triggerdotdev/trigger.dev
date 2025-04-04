import { z } from "zod";

export const PRIMARY_VARIANT = "primary";
export const WARM_VARIANT = "warm";
export const COLD_VARIANT = "cold";

const Variant = z.enum([PRIMARY_VARIANT, WARM_VARIANT, COLD_VARIANT]);
export type Variant = z.infer<typeof Variant>;

const AccessoryItem = z.object({
  text: z.string(),
  variant: z.string().optional(),
  url: z.string().optional(),
});

const Accessory = z.object({
  items: z.array(AccessoryItem),
  style: z.enum(["codepath"]).optional(),
});

export type Accessory = z.infer<typeof Accessory>;

export const TaskEventStyle = z
  .object({
    icon: z.string().optional(),
    variant: Variant.optional(),
    accessory: Accessory.optional(),
  })
  .default({
    icon: undefined,
    variant: undefined,
  });

export type TaskEventStyle = z.infer<typeof TaskEventStyle>;
