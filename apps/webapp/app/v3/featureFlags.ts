import { z } from "zod";

export const FEATURE_FLAG = {
  defaultWorkerInstanceGroupId: "defaultWorkerInstanceGroupId",
  taskEventRepository: "taskEventRepository",
  hasQueryAccess: "hasQueryAccess",
  hasLogsPageAccess: "hasLogsPageAccess",
  hasAiAccess: "hasAiAccess",
  hasAiModelsAccess: "hasAiModelsAccess",
  hasComputeAccess: "hasComputeAccess",
  hasPrivateConnections: "hasPrivateConnections",
} as const;

export const FeatureFlagCatalog = {
  [FEATURE_FLAG.defaultWorkerInstanceGroupId]: z.string(),
  [FEATURE_FLAG.taskEventRepository]: z.enum(["clickhouse", "clickhouse_v2", "postgres"]),
  [FEATURE_FLAG.hasQueryAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasLogsPageAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasAiAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasAiModelsAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasComputeAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasPrivateConnections]: z.coerce.boolean(),
};

export type FeatureFlagKey = keyof typeof FeatureFlagCatalog;

// Infrastructure flags that are read-only on the global flags page.
// Shown with current/resolved value but no controls.
export const GLOBAL_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
];

// Flags that are read-only on the org-level dialog.
// Shown with global value but no controls (org can't override these).
export const ORG_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
];

// Create a Zod schema from the existing catalog
export const FeatureFlagCatalogSchema = z.object(FeatureFlagCatalog);
export type FeatureFlagCatalog = z.infer<typeof FeatureFlagCatalogSchema>;

// Utility function to validate a feature flag value
export function validateFeatureFlagValue<T extends FeatureFlagKey>(
  key: T,
  value: unknown
): z.SafeParseReturnType<unknown, z.infer<(typeof FeatureFlagCatalog)[T]>> {
  return FeatureFlagCatalog[key].safeParse(value);
}

// Utility function to validate all feature flags at once
export function validateAllFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.safeParse(values);
}

// Utility function to validate partial feature flags (all keys optional)
export function validatePartialFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.partial().safeParse(values);
}

// Utility types for catalog-driven UI rendering
export type FlagControlType =
  | { type: "boolean" }
  | { type: "enum"; options: string[] }
  | { type: "string" };

export function getFlagControlType(schema: z.ZodTypeAny): FlagControlType {
  const typeName = schema._def.typeName;

  if (typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (typeName === "ZodEnum") {
    return { type: "enum", options: schema._def.values as string[] };
  }

  return { type: "string" };
}

export function getAllFlagControlTypes(): Record<string, FlagControlType> {
  const result: Record<string, FlagControlType> = {};
  for (const [key, schema] of Object.entries(FeatureFlagCatalog)) {
    result[key] = getFlagControlType(schema);
  }
  return result;
}
