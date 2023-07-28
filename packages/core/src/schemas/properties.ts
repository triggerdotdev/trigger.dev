import { z } from "zod";

/** A property that is displayed in the logs */
export const DisplayPropertySchema = z.object({
  /** The label for the property */
  label: z.string(),
  /** The value of the property */
  text: z.string(),
  /** The URL to link to when the property is clicked */
  url: z.string().optional(),
});

export const DisplayPropertiesSchema = z.array(DisplayPropertySchema);

export type DisplayProperty = z.infer<typeof DisplayPropertySchema>;

export const StyleSchema = z.object({
  /** The style, `normal` or `minimal` */
  style: z.enum(["normal", "minimal"]),
  /** A variant of the style. */
  variant: z.string().optional(),
});

export type Style = z.infer<typeof StyleSchema>;
export type StyleName = Style["style"];
