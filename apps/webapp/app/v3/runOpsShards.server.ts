import { z } from "zod";
import { isValidShardChar } from "@trigger.dev/core/v3/isomorphic";
import { isValidDatabaseUrl } from "~/utils/db";

const KnobsSchema = z
  .object({
    writerPoolTimeout: z.number().int().optional(),
    writerConnectionTimeout: z.number().int().optional(),
    writerDriverAdapter: z.boolean().optional(),
    connectionLimit: z.number().int().optional(),
    replicaConnectionLimit: z.number().int().optional(),
    replicaPoolTimeout: z.number().int().optional(),
    replicaConnectionTimeout: z.number().int().optional(),
    replicaDriverAdapter: z.boolean().optional(),
    transactionMaxWaitMs: z.number().int().optional(),
    transactionStartRetryEnabled: z.boolean().optional(),
    transactionStartRetryMaxAttempts: z.number().int().optional(),
    transactionStartRetryBackoffMinMs: z.number().int().optional(),
    transactionStartRetryBackoffMaxMs: z.number().int().optional(),
    transactionStartRetryBudgetPerSec: z.number().int().optional(),
    transactionStartRetryBudgetBurst: z.number().int().optional(),
  })
  .strict();
export type RunOpsShardKnobs = z.infer<typeof KnobsSchema>;

const ReplicationSchema = z.object({
  slotName: z.string().min(1),
  publicationName: z.string().min(1),
  originGeneration: z.number().int().min(2).max(255),
});

const DescriptorSchema = z
  .object({
    key: z.string().refine(isValidShardChar, "shard key must be a single [a-z0-9] char"),
    region: z.string().min(1),
    url: z.string().refine(isValidDatabaseUrl, "url is invalid").optional(),
    replicaUrl: z.string().refine(isValidDatabaseUrl, "replicaUrl is invalid").optional(),
    directUrl: z.string().refine(isValidDatabaseUrl, "directUrl is invalid").optional(),
    replication: ReplicationSchema.optional(),
    knobs: KnobsSchema.optional(),
    aliasOf: z.literal("new").optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const hasUrl = d.url !== undefined;
    const hasAlias = d.aliasOf !== undefined;
    if (hasUrl === hasAlias) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of url or aliasOf is required",
      });
    }
    if (!hasAlias && d.replication === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replication is required unless aliasOf is set",
      });
    }
  });

export type RunOpsShardDescriptor = z.infer<typeof DescriptorSchema>;

// Boot-validated transform, in the style of parseMachinePresetCsv. Undefined and "" both mean the
// off state and resolve to []. The undefined guard is load-bearing: an unguarded JSON.parse would
// kill every single-DB boot, which never sets this variable.
export function parseRunOpsShards(
  raw: string | undefined,
  ctx: z.RefinementCtx
): RunOpsShardDescriptor[] {
  if (raw === undefined || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RUN_OPS_SHARDS is not valid JSON" });
    return z.NEVER;
  }

  const result = z.array(DescriptorSchema).safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `RUN_OPS_SHARDS[${issue.path.join(".")}]: ${issue.message}`,
      });
    }
    return z.NEVER;
  }

  const keys = new Set<string>();
  const gens = new Set<number>();
  for (const d of result.data) {
    if (keys.has(d.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `RUN_OPS_SHARDS: duplicate key ${d.key}`,
      });
      return z.NEVER;
    }
    keys.add(d.key);
    if (d.replication) {
      if (gens.has(d.replication.originGeneration)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RUN_OPS_SHARDS: duplicate originGeneration ${d.replication.originGeneration}`,
        });
        return z.NEVER;
      }
      gens.add(d.replication.originGeneration);
    }
  }

  return result.data;
}

// A non-empty shard list requires the gen-1 new store, because gen-1 v1 ids resolve to "new"
// forever (append-only). Pure so the boot refinement and its test share one rule.
export function validateShardListAgainstNewUrl(
  shards: RunOpsShardDescriptor[],
  newUrl: string | undefined
): boolean {
  return shards.length === 0 || !!newUrl;
}
