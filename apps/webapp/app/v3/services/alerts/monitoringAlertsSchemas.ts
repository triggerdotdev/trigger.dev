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

export const MonitoringAlertsCreateBodySchema = z
  .object({
    capabilityKey: z.string(),
    environment: z.enum(["dev", "staging", "prod", "preview"]),
    branch: BranchSchema.optional(),
    params: MonitoringAlertsScopeParamsSchema,
    condition: conditionSchema,
    behavior: behaviorSchema,
    notifiers: z
      .array(notifierRefSchema)
      .min(1, "At least one notifier is required")
      .refine((notifiers) => notifiers.every((n) => n.type !== "chat" || Boolean(n.chatId)), {
        message: "A chat notifier must include chatId",
      }),
    name: z.string().optional(),
    query: z.string().max(8192).optional(),
    signal: z
      .object({ mode: z.enum(["threshold", "absence", "match"]), measure: z.string().optional() })
      .optional(),
  })
  .refine(branchOnlyForPreview.check, branchOnlyForPreview.issue)
  .refine(
    (v) => v.capabilityKey === "custom.query" || (v.query === undefined && v.signal === undefined),
    { message: "query and signal are only valid for the custom.query capability", path: ["query"] }
  );

export const MonitoringAlertsAnalyzeBodySchema = z.object({
  query: z.string().min(1).max(8192),
});
