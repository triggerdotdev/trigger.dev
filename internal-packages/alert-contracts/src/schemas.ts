import { z } from "zod";

export const alertAreaSchema = z.enum(["queues", "runs", "health", "limits", "errors", "query"]);
export type AlertArea = z.infer<typeof alertAreaSchema>;

export const AREA_DESCRIPTION: Partial<Record<AlertArea, string>> = {
  limits:
    "Watch the limits that can interrupt or degrade runtime flow: when hit, they block, drop or slow runs and webhooks.",
};

export const alertGroupSchema = z.enum(["platform", "webhooks"]);
export type AlertGroup = z.infer<typeof alertGroupSchema>;

export const limitSignalSchema = z.enum(["approaching", "limited"]);
export type LimitSignal = z.infer<typeof limitSignalSchema>;

export const alertSignalSchema = z.enum(["metric", "state", "event"]);
export type AlertSignal = z.infer<typeof alertSignalSchema>;

export const alertKindSchema = z.enum(["threshold", "state", "occurrence", "absence"]);
export type AlertKind = z.infer<typeof alertKindSchema>;

export const alertUnitSchema = z.enum([
  "count",
  "duration_ms",
  "percent",
  "rate_per_hour",
  "ms",
  "seconds",
]);
export type AlertUnit = z.infer<typeof alertUnitSchema>;

export const alertSurfaceSchema = z.enum(["alerts_page", "contextual", "agent", "mcp"]);
export type AlertSurface = z.infer<typeof alertSurfaceSchema>;

export const alertFreshnessSchema = z.enum(["gauge", "counter", "snapshot"]);
export type AlertFreshness = z.infer<typeof alertFreshnessSchema>;

export const alertScopeTypeSchema = z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]);
export type AlertScopeType = z.infer<typeof alertScopeTypeSchema>;

export const capabilityParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: alertUnitSchema.optional(),
  default: z.number().finite(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type CapabilityParam = z.infer<typeof capabilityParamSchema>;

const CTX_PLACEHOLDER = /\{\{ctx\.([^}]+)\}\}/g;

function ctxNames(template: string | undefined): string[] {
  return template ? [...template.matchAll(CTX_PLACEHOLDER)].map((m) => m[1]!) : [];
}

export const queryBindingSchema = z
  .object({
    type: z.literal("query"),
    template: z.string().optional(),
    table: z.string().optional(),
    minCadenceSec: z.number(),
    compositeOf: z.array(z.string()).optional(),
    params: z.array(capabilityParamSchema).optional(),
    windowParam: z.string().optional(),
    emit: z.enum(["scalar", "rows"]).optional(),
    ctx: z.array(z.string()).optional(),
    seriesTemplate: z.string().optional(),
    rowKey: z.array(z.string()).optional(),
    fullRetention: z.boolean().optional(),
    source: z.literal("custom").optional(),
    measure: z.string().optional(),
    groupBy: z.array(z.string()).optional(),
    rowTimeColumn: z.string().optional(),
    signalTemplates: z
      .object({ approaching: z.string().optional(), limited: z.string().optional() })
      .strict()
      .optional(),
  })
  .superRefine((binding, ctx) => {
    const declared = new Set(binding.ctx ?? []);
    for (const name of [...ctxNames(binding.template), ...ctxNames(binding.seriesTemplate)]) {
      if (!declared.has(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `undeclared ctx name: "${name}"` });
      }
    }
  });

export const alertBindingSchema = queryBindingSchema;
export type AlertBinding = z.infer<typeof alertBindingSchema>;

export const alertCapabilitySchema = z
  .object({
    key: z.string(),
    area: alertAreaSchema,
    group: alertGroupSchema.optional(),
    signal: alertSignalSchema,
    allowedKinds: z.array(alertKindSchema),
    binding: alertBindingSchema,
    title: z.string(),
    shortTitle: z.string().optional(),
    description: z.string().optional(),
    unit: alertUnitSchema.optional(),
    surfaces: z.array(alertSurfaceSchema),
    curated: z.boolean(),
    minWindowSec: z.number().optional(),
    freshness: alertFreshnessSchema,
    minCadenceSec: z.number(),
    allowedScopes: z.array(alertScopeTypeSchema),
    supportedSignals: z.array(limitSignalSchema).optional(),
  })
  .refine((cap) => cap.area !== "limits" || !!cap.group || !!cap.binding.compositeOf, {
    message: "limits capabilities require a group",
  });
export type AlertCapability = z.infer<typeof alertCapabilitySchema>;

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threshold"),
    operator: z.enum([">", "<"]),
    value: z.number().finite(),
    windowSec: z.number().int().positive(),
    holdSec: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("state"),
    stateKey: z.string(),
    holdSec: z.number().int().positive().optional(),
    params: z.record(z.string(), z.number().finite()).optional(),
    compositeMode: z.enum(["any", "all"]).optional(),
    signals: z.array(limitSignalSchema).optional(),
    components: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    kind: z.literal("occurrence"),
  }),
  z.object({
    kind: z.literal("absence"),
    quietWindowSec: z.number().int().positive(),
  }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const evaluationOutcomeSchema = z.enum(["met", "not_met", "impossible", "unavailable"]);
export type EvaluationOutcome = z.infer<typeof evaluationOutcomeSchema>;

export const occurrenceSchema = z.object({
  sourceEventId: z.string().min(1),
  rowTime: z.coerce.date(),
  expiresAt: z.coerce.date(),
  facts: z.record(z.string(), z.unknown()),
});
export type Occurrence = z.infer<typeof occurrenceSchema>;

export function occurrenceExpiresAt(rowTime: Date, retentionSec: number): Date {
  return new Date(rowTime.getTime() + retentionSec * 1000);
}

export const evaluationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stateful"),
    outcome: evaluationOutcomeSchema,
    facts: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("occurrence"),
    outcome: evaluationOutcomeSchema,
    occurrences: z.array(occurrenceSchema),
    nextCursor: z.string().optional(),
    facts: z.record(z.string(), z.unknown()),
  }),
]);
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

export const alertLifecycleSchema = z.enum(["active", "completed", "expired", "stopped"]);
export type AlertLifecycle = z.infer<typeof alertLifecycleSchema>;

export const alertAttentionSchema = z.enum(["clear", "needs_attention"]);
export type AlertAttention = z.infer<typeof alertAttentionSchema>;

export const observedConditionSchema = z.enum(["unknown", "met", "not_met"]);
export type ObservedCondition = z.infer<typeof observedConditionSchema>;

export const alertEventTypeSchema = z.enum([
  "raised",
  "recovered",
  "resolved",
  "expired",
  "stopped",
]);
export type AlertEventType = z.infer<typeof alertEventTypeSchema>;

export const alertDeliveryStatusSchema = z.enum(["pending", "delivering", "delivered", "failed"]);
export type AlertDeliveryStatus = z.infer<typeof alertDeliveryStatusSchema>;

export const behaviorSchema = z.object({
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .refine((value) => Date.parse(value) > Date.now(), { message: "Expiry must be in the future" })
    .optional(),
});
export type Behavior = z.infer<typeof behaviorSchema>;

const notifierRefBaseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel"), channelId: z.string() }),
  z.object({
    type: z.literal("chat"),
    chatId: z.string().optional(),
    conversationId: z.string().optional(),
    userId: z.string().optional(),
  }),
]);

export const notifierRefSchema = notifierRefBaseSchema.refine(
  (ref) => ref.type !== "chat" || !!(ref.chatId || ref.conversationId || ref.userId),
  { message: "chat notifier requires at least one of chatId, conversationId, or userId" }
);
export type NotifierRef = z.infer<typeof notifierRefSchema>;

export function notifierRefKey(ref: NotifierRef): string {
  switch (ref.type) {
    case "channel":
      return `channel:${ref.channelId}`;
    case "chat":
      return `chat:${ref.chatId ?? ref.conversationId ?? "project"}:${ref.userId ?? "-"}`;
  }
}

export const querySignalSchema = z
  .object({
    v: z.literal(1),
    sources: z.array(z.object({ sourceId: z.string(), windowColumn: z.string() }).strict()),
    mode: z.enum(["threshold", "absence", "match"]),
    measure: z.string().optional(),
    groupColumns: z.array(z.string()).optional(),
    rowId: z
      .object({ sourceId: z.string(), column: z.string(), eventColumn: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type QuerySignal = z.infer<typeof querySignalSchema>;

export const alertParamsSchema = z.object({
  environmentId: z.string(),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("queue"), queue: z.string() }),
    z.object({ type: z.literal("queuePattern"), pattern: z.string() }),
    z.object({ type: z.literal("task"), taskIdentifier: z.string() }),
    z.object({ type: z.literal("all") }),
    /** One error group, identified by task + fingerprint (same pair as errors_v1). */
    z.object({
      type: z.literal("errorGroup"),
      taskIdentifier: z.string(),
      fingerprint: z.string(),
    }),
  ]),
  windowSec: z.number().optional(),
  querySignal: querySignalSchema.optional(),
});
export type AlertParams = z.infer<typeof alertParamsSchema>;

export function isScopeAllowed(capability: AlertCapability, scopeType: AlertScopeType): boolean {
  return capability.allowedScopes.includes(scopeType);
}

export class ScopeNotAllowedError extends Error {
  constructor(
    public readonly capabilityKey: string,
    public readonly scopeType: string
  ) {
    super(`"${scopeType}" scope is not valid for ${capabilityKey}`);
    this.name = "ScopeNotAllowedError";
  }
}

export function compileTemplate(
  template: string,
  scope: string,
  params?: Record<string, number>,
  /** Inserted verbatim: values must already be quoted SQL literals. */
  ctx?: Record<string, string>
): string {
  let result = template.replace(/\{\{scope\}\}/g, scope);
  if (ctx) {
    for (const [key, value] of Object.entries(ctx)) {
      result = result.split(`{{ctx.${key}}}`).join(value);
    }
  }
  if (result.includes("{{ctx.until}}")) {
    const next = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
    const literal = `'${next.toISOString().slice(0, 19).replace("T", " ")}'`;
    result = result.split("{{ctx.until}}").join(literal);
  }
  const leftoverCtx = result.match(/\{\{ctx\.[^}]+\}\}/);
  if (leftoverCtx) {
    throw new Error(`unresolved ctx placeholder: ${leftoverCtx[0]}`);
  }
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (!Number.isFinite(value)) {
        throw new Error(`param "${key}" is not finite`);
      }
      result = result.split(`{{p.${key}}}`).join(value.toString());
    }
  }
  const leftover = result.match(/\{\{p\.[^}]+\}\}/);
  if (leftover) {
    throw new Error(`unresolved param placeholder: ${leftover[0]}`);
  }
  return result;
}

export function validateConditionParams(
  params: Record<string, number>,
  declared: CapabilityParam[]
): void {
  const declaredKeys = new Set(declared.map((p) => p.key));
  for (const key of Object.keys(params)) {
    if (!declaredKeys.has(key)) {
      throw new Error(`unknown param key: "${key}"`);
    }
  }
  for (const decl of declared) {
    const value = params[decl.key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      throw new Error(`param "${decl.key}" is not finite`);
    }
    if (decl.min !== undefined && value < decl.min) {
      throw new Error(`param "${decl.key}" is below min ${decl.min}`);
    }
    if (decl.max !== undefined && value > decl.max) {
      throw new Error(`param "${decl.key}" is above max ${decl.max}`);
    }
  }
}
