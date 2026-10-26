import { z } from "zod";

export const alertInvestigateContextSchema = z.object({
  alertId: z.string(),
  capabilityKey: z.string(),
  environmentId: z.string(),
  scope: z
    .object({
      type: z.string(),
      queue: z.string().optional(),
      pattern: z.string().optional(),
      taskIdentifier: z.string().optional(),
    })
    .optional(),
  facts: z.record(z.string(), z.unknown()),
  timeWindow: z
    .object({
      startAt: z.string(),
      endAt: z.string(),
    })
    .optional(),
});

export type AlertInvestigateContext = z.infer<typeof alertInvestigateContextSchema>;

export function isAlertExpiry(value: string): boolean {
  if (value === "none" || /^[1-9]\d*[hd]$/.test(value)) return true;
  return value.includes("T") && !Number.isNaN(Date.parse(value));
}

export const alertExpirySchema = z
  .string()
  .refine(isAlertExpiry, "expiry must be none, <n>h, <n>d or an ISO timestamp")
  .describe("none, <n>h, <n>d or an ISO timestamp. Alerts have no maximum.");

export function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const querySignalChoiceSchema = z.object({
  mode: z.enum(["threshold", "absence", "match"]),
  measure: z.string().max(256).optional(),
});

export const alertDraftPatchSchema = z.object({
  area: z.enum(["queues", "runs", "health", "errors", "query"]).optional(),
  what: z.string().optional(),
  query: z.string().max(8192).optional(),
  querySignalChoice: querySignalChoiceSchema.optional(),
  scope: z
    .object({
      type: z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]),
      value: z.string().optional(),
      errorId: z
        .string()
        .max(128)
        .optional()
        .describe("errorGroup: the error_… id from list_errors."),
      taskIdentifier: z.string().max(128).optional(),
      fingerprint: z.string().max(128).optional(),
    })
    .optional(),
  condition: z
    .object({
      kind: z.enum(["threshold", "state", "occurrence", "absence"]).optional(),
      operator: z.enum([">", "<"]).optional(),
      value: z.number().optional(),
      unit: z.string().optional(),
      windowSec: z.number().optional(),
      params: z.preprocess(parseJsonText, z.record(z.string(), z.number())).optional(),
    })
    .optional(),
  behavior: z
    .object({
      expiresAt: z.string().optional(),
      expiry: alertExpirySchema.optional(),
    })
    .optional(),
  notifiers: z
    .array(
      z.object({
        type: z.enum(["channel", "chat"]),
        channelId: z.string().optional(),
        chatId: z.string().optional(),
      })
    )
    .optional(),
});

export type AlertDraftPatch = z.infer<typeof alertDraftPatchSchema>;

const draftText = z.string().max(256);

export const alertCreationDraftSchema = z.object({
  capabilityKey: draftText.optional(),
  answers: z.object({
    area: z.enum(["queues", "runs", "health", "errors", "query"]).optional(),
    what: draftText.optional(),
    scope: z.enum(["queue", "queuePattern", "task", "all", "errorGroup", "fingerprint"]).optional(),
    scopeValue: draftText.optional(),
    condition: z.string().max(2000).optional(),
    conditionParams: z.record(z.string(), z.number()).optional(),
    windowMinutes: z.number().optional(),
    notifiers: z.array(draftText).max(20).optional(),
    expiry: draftText.optional(),
    query: z.string().max(8192).optional(),
    querySignalChoice: querySignalChoiceSchema.optional(),
  }),
});

export type AlertCreationDraft = z.infer<typeof alertCreationDraftSchema>;

/** The draft with unknown keys stripped, or undefined when it doesn't validate. */
export function parseAlertCreationDraft(raw: unknown): AlertCreationDraft | undefined {
  const parsed = alertCreationDraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
