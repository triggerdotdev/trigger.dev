import { z } from "zod";
import { DeployBuildPath } from "@trigger.dev/core/v3";

export const FEATURE_FLAG = {
  defaultWorkerInstanceGroupId: "defaultWorkerInstanceGroupId",
  taskEventRepository: "taskEventRepository",
  hasQueryAccess: "hasQueryAccess",
  hasLogsPageAccess: "hasLogsPageAccess",
  hasWebhooksAccess: "hasWebhooksAccess",
  hasAiAccess: "hasAiAccess",
  hasDashboardAgentAccess: "hasDashboardAgentAccess",
  dashboardAgentTurnEvalsEnabled: "dashboardAgentTurnEvalsEnabled",
  promotedDashboardAgentPrompt: "promotedDashboardAgentPrompt",
  hasComputeAccess: "hasComputeAccess",
  hasPrivateConnections: "hasPrivateConnections",
  hasSso: "hasSso",
  hasThemeSwitcher: "hasThemeSwitcher",
  mollifierEnabled: "mollifierEnabled",
  workerQueueScheduledSplitEnabled: "workerQueueScheduledSplitEnabled",
  internalApiOriginEnabled: "internalApiOriginEnabled",
  realtimeBackend: "realtimeBackend",
  computeMigrationEnabled: "computeMigrationEnabled",
  computeMigrationFreePercentage: "computeMigrationFreePercentage",
  computeMigrationPaidPercentage: "computeMigrationPaidPercentage",
  computeMigrationRequireTemplate: "computeMigrationRequireTemplate",
  runOpsMintKind: "runOpsMintKind",
  // Grace-linger stamp carried alongside runOpsMintKind on flip. See mintFlipGrace.ts.
  runOpsMintKindPrev: "runOpsMintKindPrev",
  runOpsMintKindFlippedAt: "runOpsMintKindFlippedAt",
  // Gen-2 mint shard pins, read from the org override blob only. See runOpsMintShard.server.ts.
  runOpsMintShard: "runOpsMintShard",
  runOpsMintShardEnvPins: "runOpsMintShardEnvPins",
  // The active mint-shard list, global only. Lives here rather than in the environment because a
  // rolling deploy runs two environment values at once for hours. See mintShardGrace.ts.
  runOpsMintShardSet: "runOpsMintShardSet",
  runOpsMintShardSetPrev: "runOpsMintShardSetPrev",
  runOpsMintShardSetFlippedAt: "runOpsMintShardSetFlippedAt",
  // Fleet-wide pin for the complete cutover. Beats every per-org and per-env pin.
  runOpsMintShardOverride: "runOpsMintShardOverride",
  queueMetricsUiEnabled: "queueMetricsUiEnabled",
  // Build path for CLI deploys, resolved by DeploymentService.getDeploySettings.
  deployBuildPath: "deployBuildPath",
  deployBuildPathPreview: "deployBuildPathPreview",
  deployBuildPathStaging: "deployBuildPathStaging",
  deployBuildPathProduction: "deployBuildPathProduction",
  // Per-organization rollout for creating additional environment API keys.
  additionalApiKeysEnabled: "additionalApiKeysEnabled",
  // System-wide kill switch for issuing additional environment API keys.
  additionalApiKeyIssuanceEnabled: "additionalApiKeyIssuanceEnabled",
  // System-wide kill switch for additional (scoped) environment API-key lookup.
  // Defaults off; enable during rollout once the new lookup path is trusted.
  additionalApiKeyLookupEnabled: "additionalApiKeyLookupEnabled",
  // The execution-snapshot store rollout dial. A flag rather than an environment variable because
  // a sustained append failure burns a task attempt per transition, so dial-down is a correctness
  // control and cannot wait for a deploy.
  snapshotStoreMode: "snapshotStoreMode",
  // The hard stop for the execution-snapshot store, deployment-wide. Separate from the dial because
  // the dial governs births only: turning it down cannot stop a resident run from mirroring, and
  // must not, or every resident head freezes while Postgres advances.
  snapshotStoreHalt: "snapshotStoreHalt",
  // Per-org override, read from the org blob only. Deliberately narrower than the global key:
  // snapshot reads are global, so an org at a read position would read state its own writes never
  // created. Stripped from org payloads by withoutOrgForbiddenSnapshotKeys.
  snapshotStoreOrgMode: "snapshotStoreOrgMode",
  // One-way residency latch. See the catalog entry below.
  snapshotStoreEverEnabled: "snapshotStoreEverEnabled",
  // Per-org one-way residency latch, the per-org sibling of snapshotStoreEverEnabled. System-set on
  // the org save path when the org dial first moves past `off`, never cleared. See the catalog entry.
  snapshotStoreOrgEverEnabled: "snapshotStoreOrgEverEnabled",
} as const;

export const FeatureFlagCatalog = {
  [FEATURE_FLAG.defaultWorkerInstanceGroupId]: z.string(),
  [FEATURE_FLAG.taskEventRepository]: z.enum(["clickhouse", "clickhouse_v2", "postgres"]),
  [FEATURE_FLAG.hasQueryAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasLogsPageAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasWebhooksAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasAiAccess]: z.coerce.boolean(),
  // Gates the in-dashboard AI agent panel. Controllable globally and per-org
  // (org wins). Defaults off via DASHBOARD_AGENT_ENABLED.
  [FEATURE_FLAG.hasDashboardAgentAccess]: z.coerce.boolean(),
  // Whether this org's agent turns may be sampled for the quality judge. A data-handling
  // switch, not an entitlement: an org that turns it off has its turns judged never, and a
  // setting that can't be read is treated as off. Per-org override wins; on by default.
  // Strict z.boolean(): coercion reads the string "false" as true, which would keep judging
  // an org that asked us to stop.
  [FEATURE_FLAG.dashboardAgentTurnEvalsEnabled]: z.boolean(),
  // A JSON string because this catalog is scalar-only. Validated where it's read, in
  // `suggested-prompts/promotedPrompt.server.ts`.
  [FEATURE_FLAG.promotedDashboardAgentPrompt]: z.string(),
  [FEATURE_FLAG.hasComputeAccess]: z.coerce.boolean(),
  [FEATURE_FLAG.hasPrivateConnections]: z.coerce.boolean(),
  [FEATURE_FLAG.hasSso]: z.coerce.boolean(),
  // Gates the Interface theme setting in /account. Off by default.
  [FEATURE_FLAG.hasThemeSwitcher]: z.coerce.boolean(),
  [FEATURE_FLAG.mollifierEnabled]: z.coerce.boolean(),
  [FEATURE_FLAG.workerQueueScheduledSplitEnabled]: z.coerce.boolean(),
  // Routes deployed runs' TRIGGER_API_URL to INTERNAL_API_ORIGIN. Per-org, with
  // INTERNAL_API_ORIGIN_ENABLED as the global default (org wins). No-op unless
  // INTERNAL_API_ORIGIN is set.
  // Strict z.boolean(): coercion turns the string "false" into true, which
  // would silently enable the wrong orgs if written as a string.
  [FEATURE_FLAG.internalApiOriginEnabled]: z.boolean(),
  // Which backend serves the realtime run feed. Controllable
  // globally and per-org (org wins). Defaults to "electric" when unset.
  // "shadow" serves Electric but diffs the native path in the background.
  [FEATURE_FLAG.realtimeBackend]: z.enum(["electric", "native", "shadow"]),
  // Strict z.boolean() (not z.coerce.boolean()): coercion turns the string "false"
  // into true, which would silently flip this kill switch / per-org exclude the wrong
  // way if written as a string via the admin PAT route. The admin toggle sends a real
  // boolean, so this only rejects the dangerous stringified case.
  [FEATURE_FLAG.computeMigrationEnabled]: z.boolean(),
  [FEATURE_FLAG.computeMigrationFreePercentage]: z.coerce.number().int().min(0).max(100),
  [FEATURE_FLAG.computeMigrationPaidPercentage]: z.coerce.number().int().min(0).max(100),
  // When on, migrated orgs build their compute template in required mode at deploy
  // (fails the deploy on error) instead of shadow. Strict boolean (see above).
  [FEATURE_FLAG.computeMigrationRequireTemplate]: z.boolean(),
  // Per-org run-ops-id mint cutover. Defaults to "cuid"; only honored when
  // RUN_OPS_MINT_ENABLED is on AND isSplitEnabled() is true.
  [FEATURE_FLAG.runOpsMintKind]: z.enum(["cuid", "runOpsId"]),
  // Grace-linger stamp: the previously-effective kind and the flip timestamp, written
  // by stampMintKindFlip on a genuine flip. Display-only (see ORG_LOCKED_FLAGS).
  [FEATURE_FLAG.runOpsMintKindPrev]: z.enum(["cuid", "runOpsId"]),
  [FEATURE_FLAG.runOpsMintKindFlippedAt]: z.string().datetime(),
  // Pins one org to a gen-2 mint shard. "new" holds the org on gen-1 run-ops ids, which is how
  // a canary keeps the fleet's default while one org moves. Only honored while the key is in
  // the active list; a drained key falls through to the hash.
  [FEATURE_FLAG.runOpsMintShard]: z
    .string()
    .refine((v) => v === "new" || /^[a-z0-9]$/.test(v), 'must be a single [a-z0-9] char, or "new"'),
  // Per-environment pins as JSON: {"<environmentId>": "<shard key>"}. A JSON string because
  // this catalog is scalar-only. Rejected at write, so a typo cannot silently un-pin an env.
  [FEATURE_FLAG.runOpsMintShardEnvPins]: z.string().superRefine((raw, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail("must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("must be a JSON object mapping environment id to shard key");
    }
    for (const [environmentId, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !(value === "new" || /^[a-z0-9]$/.test(value))) {
        fail(`"${environmentId}" must map to a single [a-z0-9] char, or "new"`);
      }
    }
  }),
  // CSV of the shard keys eligible for root minting right now. Empty means no gen-2 minting.
  // Reserved keys are rejected, because "new" already means gen-1.
  [FEATURE_FLAG.runOpsMintShardSet]: z.string().refine(
    (v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((k) => /^[a-z0-9]$/.test(k)),
    "must be a CSV of single [a-z0-9] chars"
  ),
  // Grace stamp: the previously-effective list and the flip time, written by
  // stampMintShardSetFlip on a genuine change. Display-only (see ORG_LOCKED_FLAGS).
  [FEATURE_FLAG.runOpsMintShardSetPrev]: z.string(),
  [FEATURE_FLAG.runOpsMintShardSetFlippedAt]: z.string().datetime(),
  // Sends every environment to one shard, outranking every pin, so a cutover needs no per-org
  // visit. "new" holds the whole fleet on gen-1. Only honored while the key is in the active set.
  [FEATURE_FLAG.runOpsMintShardOverride]: z
    .string()
    .refine((v) => v === "new" || /^[a-z0-9]$/.test(v), 'must be a single [a-z0-9] char, or "new"'),
  // Per-org access to the Queue Metrics dashboard UI (view only; emission is global and
  // separate). Off unless enabled for the org.
  [FEATURE_FLAG.queueMetricsUiEnabled]: z.coerce.boolean(),
  [FEATURE_FLAG.deployBuildPath]: DeployBuildPath,
  [FEATURE_FLAG.deployBuildPathPreview]: DeployBuildPath,
  [FEATURE_FLAG.deployBuildPathStaging]: DeployBuildPath,
  [FEATURE_FLAG.deployBuildPathProduction]: DeployBuildPath,
  // Strict booleans prevent a stringified "false" from silently enabling API-key
  // creation or lookup. Cold/absent values resolve to the safe `false`.
  [FEATURE_FLAG.additionalApiKeysEnabled]: z.boolean(),
  [FEATURE_FLAG.additionalApiKeyIssuanceEnabled]: z.boolean(),
  [FEATURE_FLAG.additionalApiKeyLookupEnabled]: z.boolean(),
  [FEATURE_FLAG.snapshotStoreMode]: z.enum(["off", "dual-write", "redis-read", "redis-only"]),
  [FEATURE_FLAG.snapshotStoreOrgMode]: z.enum(["off", "dual-write", "redis-read", "redis-only"]),
  /**
   * Whether this deployment has EVER had the store enabled. One way: set when the first dial or
   * per-organisation override moves past `off`, and never cleared automatically.
   *
   * It exists so that `off` means genuinely inert before a ramp. A transition has to ask whether its
   * run is resident, and the keyspace is the only record of that, so at `off` after a ramp every
   * transition must still ask or a resident run's head freezes. Before any ramp nothing CAN be
   * resident, so the question has one possible answer and asking it is pure cost: measured at 2 per
   * cent with a healthy endpoint and four times the run duration with a slow one.
   *
   * Strict boolean, like the other kill switches: a stringified "false" read as true would put the
   * whole fleet back on the run path.
   */
  [FEATURE_FLAG.snapshotStoreEverEnabled]: z.boolean(),
  // Per-org sibling of snapshotStoreEverEnabled. One way: set when the org dial first moves past
  // `off`, never cleared, so an org toggled dual-write -> off keeps probing its resident runs.
  // System-set, so stripped from org payloads by withoutOrgForbiddenSnapshotKeys. Strict boolean.
  [FEATURE_FLAG.snapshotStoreOrgEverEnabled]: z.boolean(),
  // Strict, like the other kill switches: a stringified "false" read as true would freeze every
  // resident run's Redis head.
  [FEATURE_FLAG.snapshotStoreHalt]: z.boolean(),
};

export type FeatureFlagKey = keyof typeof FeatureFlagCatalog;

// Infrastructure flags, plus org-scoped-only flags, that are read-only on the global flags
// page. Shown with current/resolved value but no controls. An org-scoped-only flag belongs
// here because its resolver never reads a global row, so an editable global control would
// offer a setting that does nothing.
export const GLOBAL_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
  FEATURE_FLAG.runOpsMintShard,
  FEATURE_FLAG.runOpsMintShardEnvPins,
  // Grace stamps are computed server-side. An editable control here would discard what it saves.
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
  // Read from the org blob only, and refused outright on a global save, so an editable control here
  // would offer a setting whose only outcome is a 400.
  FEATURE_FLAG.snapshotStoreOrgMode,
  FEATURE_FLAG.snapshotStoreOrgEverEnabled,
];

// Flags that are read-only on the org-level dialog.
// Shown with global value but no controls (org can't override these).
export const ORG_LOCKED_FLAGS: FeatureFlagKey[] = [
  FEATURE_FLAG.defaultWorkerInstanceGroupId,
  FEATURE_FLAG.taskEventRepository,
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
  // System-wide only — orgs must not be able to override these kill switches.
  FEATURE_FLAG.additionalApiKeyIssuanceEnabled,
  FEATURE_FLAG.additionalApiKeyLookupEnabled,
  // The active mint-shard list is deployment-wide; only the pins are per-org.
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
  FEATURE_FLAG.runOpsMintShardOverride,
  // The dial and the hard stop are deployment-wide; only snapshotStoreOrgMode is per-org.
  FEATURE_FLAG.snapshotStoreMode,
  FEATURE_FLAG.snapshotStoreHalt,
  FEATURE_FLAG.snapshotStoreEverEnabled,
  // System-set latch: shown on the org dialog, but the operator never edits it.
  FEATURE_FLAG.snapshotStoreOrgEverEnabled,
];

/**
 * Drops keys an organisation must never supply. ORG_LOCKED_FLAGS is a UI predicate and no save path
 * consults it, so the line is held here — the same way the mint grace stamps are stripped.
 */
export function withoutOrgForbiddenSnapshotKeys<T extends Record<string, unknown>>(values: T): T {
  const forbidden = [
    FEATURE_FLAG.snapshotStoreMode,
    FEATURE_FLAG.snapshotStoreHalt,
    // Deployment-wide, like the other two. Nothing reads it from an organisation row, so accepting
    // it on an organisation save reports success for a setting that does nothing.
    FEATURE_FLAG.snapshotStoreEverEnabled,
    // System-set one-way latch. The save path is its only writer, so an operator-supplied value
    // (a `false` above all) must never reach the stored blob.
    FEATURE_FLAG.snapshotStoreOrgEverEnabled,
  ] as const;
  if (!forbidden.some((key) => key in values)) return values;

  const rest = { ...values };
  for (const key of forbidden) {
    delete rest[key];
  }
  return rest;
}

/**
 * One-way per-org residency latch. Sets snapshotStoreOrgEverEnabled true when the resulting org dial
 * is past `off`, and carries an already-set latch forward so a save back to `off` never clears it.
 * Mutates and returns the stamped blob, which is written with replace semantics, so the carry-forward
 * is what keeps the latch alive. Never writes `false`: an absent latch must stay distinguishable from
 * an explicit one so the resolver keeps probing a resident org rather than skipping it.
 */
export function stampSnapshotStoreOrgEverEnabled(
  existingFlags: Record<string, unknown> | null | undefined,
  stamped: Record<string, unknown>
): Record<string, unknown> {
  const alreadyLatched = (existingFlags ?? {})[FEATURE_FLAG.snapshotStoreOrgEverEnabled] === true;
  const mode = FeatureFlagCatalog[FEATURE_FLAG.snapshotStoreOrgMode].safeParse(
    stamped[FEATURE_FLAG.snapshotStoreOrgMode]
  );
  const enablingNow = mode.success && mode.data !== "off";

  if (alreadyLatched || enablingNow) {
    stamped[FEATURE_FLAG.snapshotStoreOrgEverEnabled] = true;
  }
  return stamped;
}

/**
 * Flag groups where the operator sets a `primary` and the server computes the rest. The topology
 * lives here, not in the server module, because the admin page needs it too: unsetting a primary
 * clears its stamps, and the page has to disclose that.
 */
export const GRACED_FLAG_GROUPS: ReadonlyArray<{
  primary: FeatureFlagKey;
  derived: readonly FeatureFlagKey[];
}> = [
  {
    primary: FEATURE_FLAG.runOpsMintKind,
    derived: [FEATURE_FLAG.runOpsMintKindPrev, FEATURE_FLAG.runOpsMintKindFlippedAt],
  },
  {
    primary: FEATURE_FLAG.runOpsMintShardSet,
    derived: [FEATURE_FLAG.runOpsMintShardSetPrev, FEATURE_FLAG.runOpsMintShardSetFlippedAt],
  },
];

/** The stamps deleted alongside `primary`. Empty unless `primary` is a graced primary. */
export function derivedFlagsClearedWith(primary: string): FeatureFlagKey[] {
  const group = GRACED_FLAG_GROUPS.find((g) => g.primary === primary);
  return group ? [...group.derived] : [];
}

/**
 * Locked flags present in a payload the global page must refuse. On managed cloud the page never
 * offers them, so their presence means the request did not come from that page. Locally an admin
 * may unlock and edit them, so nothing is refused.
 */
export function lockedFlagsInPayload(
  payloadKeys: string[],
  isManagedCloud: boolean
): FeatureFlagKey[] {
  if (!isManagedCloud) return [];
  return payloadKeys.filter((key): key is FeatureFlagKey =>
    GLOBAL_LOCKED_FLAGS.includes(key as FeatureFlagKey)
  );
}

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

// Utility function to validate partial feature flags (all keys optional)
export function validatePartialFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.partial().safeParse(values);
}

// Utility types for catalog-driven UI rendering
/**
 * Resolve whether deployed runs should use the internal API origin, from the
 * org's feature-flags JSON. Precedence: a per-org override wins in BOTH
 * directions; the global default applies only when the org has not set the
 * flag (or set it to something invalid).
 */
export function resolveInternalApiOriginEnabled({
  orgFeatureFlags,
  globalDefault,
}: {
  orgFeatureFlags: unknown;
  globalDefault: boolean;
}): boolean {
  const override =
    orgFeatureFlags && typeof orgFeatureFlags === "object" && !Array.isArray(orgFeatureFlags)
      ? (orgFeatureFlags as Record<string, unknown>)[FEATURE_FLAG.internalApiOriginEnabled]
      : undefined;

  if (override !== undefined) {
    const parsed = FeatureFlagCatalog[FEATURE_FLAG.internalApiOriginEnabled].safeParse(override);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return globalDefault;
}

/**
 * Whether the org set `dashboardAgentTurnEvalsEnabled` to something the schema rejects.
 * That flag is a consent switch, not an entitlement, so an unreadable override must not fall
 * through to the global default the way `resolveInternalApiOriginEnabled` does: the org that
 * wrote it was trying to say something, and the only safe reading of an unknown answer is no.
 */
export function hasUnreadableTurnEvalsOverride(orgFeatureFlags: unknown): boolean {
  if (!orgFeatureFlags || typeof orgFeatureFlags !== "object" || Array.isArray(orgFeatureFlags)) {
    return false;
  }

  const override = (orgFeatureFlags as Record<string, unknown>)[
    FEATURE_FLAG.dashboardAgentTurnEvalsEnabled
  ];
  if (override === undefined) return false;

  return !FeatureFlagCatalog[FEATURE_FLAG.dashboardAgentTurnEvalsEnabled].safeParse(override)
    .success;
}

export type FlagControlType =
  | { type: "boolean" }
  | { type: "enum"; options: string[] }
  | { type: "number"; min?: number; max?: number }
  | { type: "string" };

function getFlagControlType(schema: z.ZodTypeAny): FlagControlType {
  const typeName = schema._def.typeName;

  if (typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (typeName === "ZodEnum") {
    return { type: "enum", options: schema._def.values as string[] };
  }

  // z.coerce.number() reports as ZodNumber; pull min/max out of its checks
  // so the UI can render a constrained number input instead of free text.
  if (typeName === "ZodNumber") {
    const checks = (schema._def.checks ?? []) as Array<{ kind: string; value?: number }>;
    const min = checks.find((c) => c.kind === "min")?.value;
    const max = checks.find((c) => c.kind === "max")?.value;
    return { type: "number", min, max };
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
