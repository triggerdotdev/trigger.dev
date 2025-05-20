import { z } from "zod";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const logger = new SimpleStructuredLogger("env-util");

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
    logger.warn("Failed to parse additional env vars", { error, val });
    return undefined;
  }
}, z.record(z.string(), z.string()).optional());
