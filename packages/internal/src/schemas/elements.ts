import { z } from "zod";

export const DisplayElementSchema = z.object({
  label: z.string(),
  text: z.string(),
  url: z.string().optional(),
});

export const DisplayElementsSchema = z.array(DisplayElementSchema);

export type DisplayElement = z.infer<typeof DisplayElementSchema>;

export const StyleSchema = z.object({
  style: z.enum(["normal", "minimal"]),
  variant: z.string().optional(),
});

export type Style = z.infer<typeof StyleSchema>;
export type StyleName = Style["style"];
