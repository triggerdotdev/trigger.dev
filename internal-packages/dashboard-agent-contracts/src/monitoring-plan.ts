import { z } from "zod";
import { alertDraftPatchSchema, type AlertDraftPatch } from "./alert-context.js";

/** Fields a plan item's draft still needs before the review card can open it. */
export function monitoringPlanDraftGaps(draft: AlertDraftPatch): string[] {
  if (draft.area === "query") {
    return [
      ...(draft.query?.trim() ? [] : ["query"]),
      ...(draft.querySignalChoice ? [] : ["querySignalChoice"]),
    ];
  }
  return [
    ...(draft.area ? [] : ["area"]),
    ...(draft.what ? [] : ["what"]),
    ...(Object.values(draft.condition ?? {}).some((v) => v !== undefined) ? [] : ["condition"]),
  ];
}

const planItemFields = {
  id: z.string().min(1).max(32).describe('Stable across revisions, e.g. "p1".'),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(300).describe("Why this alert serves the goal."),
};

const planFields = {
  intro: z.string().max(500).optional(),
  goal: z.string().min(1).max(300),
  horizon: z.string().max(80).optional().describe('How long the plan covers, e.g. "2h".'),
  group: z.boolean().optional(),
  lineage: z.string().max(64).optional(),
};

/** What the agent sends; completeness is checked per item so errors can name the id. */
export const monitoringPlanInputSchema = z.object({
  ...planFields,
  intro: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Up to 3 sentences: if reacting to a deploy, its version and quoted commit message; one sentence on what the N alerts cover, grouped by theme in parentheses (no per-item list); a short confirmation question."
    ),
  items: z
    .array(
      z.object({
        ...planItemFields,
        summary: z.string().min(1).max(60).describe("Short label, no numbers."),
        detail: z
          .string()
          .min(1)
          .max(300)
          .describe("One generic sentence on what it watches, in words, no numbers."),
        draft: alertDraftPatchSchema,
      })
    )
    .min(1)
    .max(3),
});

export const monitoringPlanItemSchema = z.object({
  ...planItemFields,
  summary: z.string().optional(),
  detail: z.string().optional(),
  draft: alertDraftPatchSchema.superRefine((draft, ctx) => {
    for (const field of monitoringPlanDraftGaps(draft)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required` });
    }
  }),
});

export const monitoringPlanSchema = z.object({
  ...planFields,
  environmentId: z.string().optional(),
  items: z.array(monitoringPlanItemSchema).min(1).max(6),
});

export type MonitoringPlanInput = z.infer<typeof monitoringPlanInputSchema>;
export type MonitoringPlanItem = z.infer<typeof monitoringPlanItemSchema>;
export type MonitoringPlan = z.infer<typeof monitoringPlanSchema>;

export function parseMonitoringPlan(raw: unknown): MonitoringPlan | undefined {
  const parsed = monitoringPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const planDecisionInputSchema = z.object({
  decision: z.enum(["confirm", "dismiss"]),
});

export const planDecisionOutputSchema = z.object({
  ok: z.literal(true),
  decision: planDecisionInputSchema.shape.decision,
});

export type PlanDecisionInput = z.infer<typeof planDecisionInputSchema>;
export type PlanDecisionOutput = z.infer<typeof planDecisionOutputSchema>;
