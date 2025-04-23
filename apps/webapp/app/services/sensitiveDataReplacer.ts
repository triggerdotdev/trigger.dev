import { z } from "zod";

export const RedactStringSchema = z.object({
  __redactedString: z.literal(true),
  strings: z.array(z.string()),
  interpolations: z.array(z.string()),
});

export type RedactString = z.infer<typeof RedactStringSchema>;

// Replaces redacted strings with "******".
// For example, this object: {"Authorization":{"__redactedString":true,"strings":["Bearer ",""],"interpolations":["sk-1234"]}}
// Would get stringified like so: {"Authorization": "Bearer ******"}
export function sensitiveDataReplacer(key: string, value: any): any {
  if (typeof value === "object" && value !== null && value.__redactedString === true) {
    return redactString(value);
  }

  return value;
}

function redactString(value: RedactString) {
  let result = "";

  for (let i = 0; i < value.strings.length; i++) {
    result += value.strings[i];
    if (i < value.interpolations.length) {
      result += "********";
    }
  }

  return result;
}
