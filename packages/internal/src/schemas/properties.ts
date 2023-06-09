import { z } from "zod";

export const DisplayPropertySchema = z.object({
  label: z.string(),
  text: z.string(),
  url: z.string().optional(),
});

export const DisplayPropertiesSchema = z.array(DisplayPropertySchema);

export type DisplayProperty = z.infer<typeof DisplayPropertySchema>;

export const StyleSchema = z.object({
  style: z.enum(["normal", "minimal"]),
  variant: z.string().optional(),
});

export type Style = z.infer<typeof StyleSchema>;
export type StyleName = Style["style"];
