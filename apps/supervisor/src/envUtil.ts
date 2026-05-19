import { z } from "zod";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

const logger = new SimpleStructuredLogger("env-util");

const baseBoolEnv = z.preprocess((val) => {
  if (typeof val !== "string") {
    return val;
  }

  return ["true", "1"].includes(val.toLowerCase().trim());
}, z.boolean());

// Create a type-safe version that only accepts boolean defaults
export const BoolEnv = baseBoolEnv as Omit<typeof baseBoolEnv, "default"> & {
  default: (value: boolean) => z.ZodDefault<typeof baseBoolEnv>;
};

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

/**
 * Factory for env vars that hold a JSON object. The default is the empty object,
 * so callers can spread the parsed result into Kubernetes manifests without
 * branching on undefined.
 *
 * `valueValidator` constrains the shape of the parsed values:
 *   - `JsonStringMap` for `Record<string, string>` (e.g. annotations, labels)
 *   - `JsonAny` for arbitrary nested objects (e.g. `securityContext`)
 *
 * @example
 *   KUBERNETES_WORKER_POD_ANNOTATIONS: JsonObjectEnv("KUBERNETES_WORKER_POD_ANNOTATIONS", {
 *     valueValidator: JsonStringMap,
 *   }),
 */
export const JsonStringMap = z.record(z.string(), z.string());
export const JsonAny: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonAny),
    z.record(z.string(), JsonAny),
  ])
);

type JsonObjectEnvOpts<TSchema extends z.ZodTypeAny> = {
  /**
   * Schema applied to each *value* in the parsed object. Defaults to
   * `JsonStringMap` (string values).
   */
  valueValidator?: TSchema;
};

export const JsonObjectEnv = <TSchema extends z.ZodTypeAny = typeof JsonStringMap>(
  envName: string,
  opts: JsonObjectEnvOpts<TSchema> = {}
) => {
  const valueValidator = (opts.valueValidator ?? JsonStringMap) as TSchema;

  return z
    .string()
    .default("{}")
    .transform((raw, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${envName} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        });
        return z.NEVER;
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${envName} must be a JSON object (got ${
            Array.isArray(parsed) ? "array" : typeof parsed
          })`,
        });
        return z.NEVER;
      }

      const validated = z.record(z.string(), valueValidator).safeParse(parsed);
      if (!validated.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${envName} has invalid value(s): ${validated.error.message}`,
        });
        return z.NEVER;
      }

      return validated.data as z.infer<TSchema> extends z.ZodTypeAny
        ? Record<string, z.infer<TSchema>>
        : Record<string, unknown>;
    });
};
