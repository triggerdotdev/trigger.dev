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

const QUALIFIED_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const QUALIFIED_NAME_MAX = 63;
const DNS_SUBDOMAIN_MAX = 253;
const LABEL_VALUE_MAX = 63;

/**
 * isLabelValue mirrors the Kubernetes label value rules. Empty is valid upstream.
 */
function isLabelValue(value: string): boolean {
  return value.length <= LABEL_VALUE_MAX && LABEL_VALUE.test(value);
}

/**
 * isQualifiedName mirrors the Kubernetes qualified name rules used for taint and
 * label keys: an optional DNS subdomain prefix before the slash, then the name.
 * The two halves have different length limits and different case rules, so a
 * single pattern with one overall bound gets both ends wrong.
 */
function isQualifiedName(key: string): boolean {
  const slashIdx = key.indexOf("/");

  if (slashIdx === -1) {
    return key.length <= QUALIFIED_NAME_MAX && QUALIFIED_NAME.test(key);
  }

  const prefix = key.slice(0, slashIdx);
  const name = key.slice(slashIdx + 1);

  return (
    prefix.length <= DNS_SUBDOMAIN_MAX &&
    DNS_SUBDOMAIN.test(prefix) &&
    name.length <= QUALIFIED_NAME_MAX &&
    QUALIFIED_NAME.test(name)
  );
}

/**
 * A node label value. Trimmed because Kubernetes rejects surrounding whitespace
 * outright, so a padded value fails every pod create. Deliberately no `min(1)`:
 * empty is the off-switch, and the Helm chart ships empty by default.
 */
export const NodeLabelValue = z.string().trim().refine(isLabelValue, {
  message:
    "Must be a Kubernetes label value: alphanumeric, with dashes, underscores and dots inside, at most 63 characters",
});

/**
 * Comma-separated pod tolerations in the format `key=value:effect`, or `key:effect`
 * for the Exists operator. Keys and values are checked against the Kubernetes
 * naming rules here so a typo fails at startup, rather than 422ing every single
 * pod create with the cause buried in an API server message.
 */
export const Tolerations = z.string().transform((val, ctx) => {
  return val
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx === -1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid toleration format (missing effect): "${entry}"`,
        });
        return z.NEVER;
      }

      const effect = entry.slice(colonIdx + 1).trim();
      const validEffects = ["NoSchedule", "NoExecute", "PreferNoSchedule"];
      if (!validEffects.includes(effect)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid toleration effect "${effect}" in "${entry}". Must be one of: ${validEffects.join(
            ", "
          )}`,
        });
        return z.NEVER;
      }

      const keyValue = entry.slice(0, colonIdx);
      const eqIdx = keyValue.indexOf("=");
      const key = (eqIdx === -1 ? keyValue : keyValue.slice(0, eqIdx)).trim();

      if (!key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid toleration format (empty key): "${entry}"`,
        });
        return z.NEVER;
      }

      if (!isQualifiedName(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid toleration key "${key}" in "${entry}". Must be a Kubernetes taint key, optionally prefixed with a DNS subdomain.`,
        });
        return z.NEVER;
      }

      if (eqIdx === -1) {
        return { key, operator: "Exists" as const, effect };
      }

      const value = keyValue.slice(eqIdx + 1).trim();
      if (!value) {
        logger.warn(
          'Toleration has an empty value, so it matches only a taint whose value is also empty. Drop the "=" to tolerate any value of this key.',
          { entry, key }
        );
      }

      if (!isLabelValue(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid toleration value "${value}" in "${entry}". Must be a Kubernetes label value: alphanumeric, with dashes, underscores and dots inside.`,
        });
        return z.NEVER;
      }

      return {
        key,
        operator: "Equal" as const,
        value,
        effect,
      };
    });
});

/**
 * Scalar values are coerced: YAML/JSON easily produce `true` or `3` where a label
 * value is meant, and Kubernetes label values are always strings. An empty value
 * is rejected rather than passed through - as a selector it matches only nodes
 * carrying a literal empty-valued label, which pins the org to nothing.
 */
const NodeSelector = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .transform((selector, ctx) => {
    const result: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(selector)) {
      const key = rawKey.trim();
      const value = String(rawValue).trim();

      if (!isQualifiedName(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid node selector key "${rawKey}". Must be a Kubernetes label key, optionally prefixed with a DNS subdomain.`,
        });
        continue;
      }

      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Empty node selector value for key "${key}". Remove the key instead of blanking the value.`,
        });
        continue;
      }

      if (!isLabelValue(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid node selector value "${value}" for key "${key}". Must be a Kubernetes label value: alphanumeric, with dashes, underscores and dots inside, at most 63 characters.`,
        });
        continue;
      }

      result[key] = value;
    }

    return result;
  });

/**
 * Per-organization placement overrides for run pods, as JSON keyed by the
 * internal org id (the `org` label on run pods):
 * `{"<orgId>": {"nodeSelector": {"<key>": "<value>"}, "tolerations": "<csv>"}}`.
 * Tolerations use the same CSV format as `Tolerations`, or an array of such
 * entries. Everything is validated at startup for the same reason as
 * tolerations above: a typo would otherwise reject every pod create for that
 * org, with the cause buried in API errors. A blank value means no overrides.
 */
export const OrgPlacementOverrides = z
  .string()
  .optional()
  .transform((val, ctx) => {
    if (val === undefined || val.trim() === "") {
      return undefined;
    }

    try {
      return JSON.parse(val) as unknown;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid org placement overrides: not valid JSON",
      });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .record(
        z.string().min(1),
        z
          .object({
            nodeSelector: NodeSelector.optional(),
            tolerations: z
              .union([z.string(), z.array(z.string())])
              .transform((val) => (Array.isArray(val) ? val.join(",") : val))
              .pipe(Tolerations)
              .optional(),
          })
          .strict()
      )
      .optional()
  );

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
