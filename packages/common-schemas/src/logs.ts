import { z } from "zod";
import { JsonSchema } from "./json";

export const LogMessageSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  message: z.string(),
  properties: JsonSchema.default({}),
});
