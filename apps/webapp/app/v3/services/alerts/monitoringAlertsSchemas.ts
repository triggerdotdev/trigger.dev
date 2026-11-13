import {
  alertParamsSchema,
  behaviorSchema,
  conditionSchema,
  notifierRefSchema,
} from "@internal/alert-contracts";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { z } from "zod";

export const MonitoringAlertsParamsSchema = z.object({
  projectRef: z.string(),
});

const BranchSchema = z
  .string()
  .refine((branch) => Boolean(sanitizeBranchName(branch)), { message: "Invalid branch" });

const branchOnlyForPreview = {
  check: (v: { environment: string; branch?: string }) => !v.branch || v.environment === "preview",
  issue: { message: "branch is only supported for the preview environment", path: ["branch"] },
};

export const MonitoringAlertsListQuerySchema = z
  .object({
    environment: z.enum(["dev", "staging", "prod", "preview"]),
    branch: BranchSchema.optional(),
    lifecycle: z.enum(["active", "completed", "expired", "stopped"]).optional(),
    attention: z.enum(["clear", "needs_attention"]).optional(),
  })
  .refine(branchOnlyForPreview.check, branchOnlyForPreview.issue);

const MonitoringAlertsScopeParamsSchema = z.object({
  scope: alertParamsSchema.shape.scope.optional().default({ type: "all" }),
  windowSec: alertParamsSchema.shape.windowSec,
});

const AlertDraftBodySchema = z.object({
  capabilityKey: z.string(),
  params: MonitoringAlertsScopeParamsSchema,
  condition: conditionSchema,
  behavior: behaviorSchema,
  notifiers: z
    .array(notifierRefSchema)
    .min(1, "At least one channel is required")
    .refine((notifiers) => notifiers.every((n) => n.type !== "chat"), {
      message: "Chat notifiers are not supported",
    }),
  name: z.string().optional(),
  query: z.string().max(8192).optional(),
  signal: z
    .object({ mode: z.enum(["threshold", "absence", "match"]), measure: z.string().optional() })
    .optional(),
});

const queryOnlyForCustomQuery = {
  check: (v: { capabilityKey: string; query?: string; signal?: unknown }) =>
    v.capabilityKey === "custom.query" || (v.query === undefined && v.signal === undefined),
  issue: {
    message: "query and signal are only valid for the custom.query capability",
    path: ["query"],
  },
};

const MonitoringAlertsMemberBodySchema = AlertDraftBodySchema.strict().refine(
  queryOnlyForCustomQuery.check,
  queryOnlyForCustomQuery.issue
);
export type MonitoringAlertsMemberBody = z.infer<typeof MonitoringAlertsMemberBodySchema>;

export const MonitoringAlertsCreateBodySchema = AlertDraftBodySchema.extend({
  environment: z.enum(["dev", "staging", "prod", "preview"]),
  branch: BranchSchema.optional(),
  condition: z.union([
    conditionSchema,
    z.object({
      kind: z.literal("state"),
      stateKey: z.literal("group"),
      compositeMode: z.enum(["any", "all"]).optional(),
      memberAlertIds: z.array(z.string()).min(1),
    }),
  ]),
  members: z.array(MonitoringAlertsMemberBodySchema).min(1).max(20).optional(),
})
  .refine(branchOnlyForPreview.check, branchOnlyForPreview.issue)
  .refine(queryOnlyForCustomQuery.check, queryOnlyForCustomQuery.issue)
  .refine((v) => !isGroupBody(v) || groupSize(v) >= 2, {
    message: "A group needs at least 2 alerts",
    path: ["condition", "memberAlertIds"],
  })
  .refine((v) => !isGroupBody(v) || groupSize(v) <= 20, {
    message: "A group can have at most 20 alerts",
    path: ["condition", "memberAlertIds"],
  });

type GroupBodyShape = {
  condition: { kind: string; memberAlertIds?: string[] };
  members?: unknown[];
};

function isGroupBody(v: GroupBodyShape) {
  return !!v.condition.memberAlertIds || !!v.members;
}

function groupSize(v: GroupBodyShape) {
  return (v.condition.memberAlertIds?.length ?? 0) + (v.members?.length ?? 0);
}

export const MonitoringAlertsAnalyzeBodySchema = z.object({
  query: z.string().min(1).max(8192),
  signal: z
    .object({ mode: z.enum(["threshold", "absence", "match"]), measure: z.string().optional() })
    .optional(),
});
