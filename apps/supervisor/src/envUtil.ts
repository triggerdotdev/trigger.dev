import { z } from "zod";

export const BoolEnv = z.preprocess((val) => {
  if (typeof val !== "string") {
    return val;
  }

  return ["true", "1"].includes(val.toLowerCase().trim());
}, z.boolean());

export const AdditionalEnvVars = z.preprocess((val) => {
  if (typeof val !== "string") {
    return val;
  }

  if (!val) {
    return undefined;
  }

  try {
    const result = val.split(",").reduce(
      (acc, pair) => {
        const [key, value] = pair.split("=");
        if (!key || !value) {
          return acc;
        }
        acc[key.trim()] = value.trim();
        return acc;
      },
      {} as Record<string, string>
    );

    // Return undefined if no valid key-value pairs were found
    return Object.keys(result).length === 0 ? undefined : result;
  } catch (error) {
    console.warn("Failed to parse additional env vars", { error, val });
    return undefined;
  }
}, z.record(z.string(), z.string()).optional());

/**
 * Zod's `z.coerce.boolean()` doesn't work as _expected_ with "true" and "false" strings.
 * as it coerces both to `true`. This type is a workaround for that.
 */
export const CoercedBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);
