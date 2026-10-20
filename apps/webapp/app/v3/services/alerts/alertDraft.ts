import { z } from "zod";
import { parseErrorGroupScope } from "~/utils/errorGroupScope";
import { alertKindSchema, type Condition } from "@internal/alert-contracts";

export type AlertDraftScope =
  | { type: "queue"; queue: string }
  | { type: "queuePattern"; pattern: string }
  | { type: "task"; taskIdentifier: string }
  | { type: "all" }
  | { type: "errorGroup"; taskIdentifier: string; fingerprint: string };

const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isValidExpiresAt(value: string): boolean {
  if (!ISO_DATETIME_PATTERN.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() > Date.now();
}

export const ScopeTypeSchema = z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]);

/**
 * Create-alert form shape, shared between the route's client component (for client-side
 * validation) and its action (for the authoritative server-side check).
 */
export const FormSchema = z
  .object({
    capabilityKey: z.string().min(1, "Choose a metric"),
    scopeType: ScopeTypeSchema,
    scopeValue: z.string().optional(),
    conditionKind: alertKindSchema,
    operator: z.enum([">", "<"]).optional(),
    value: z.coerce.number().optional(),
    windowMinutes: z.coerce.number().optional(),
    holdMinutes: z.coerce.number().optional(),
    quietWindowMinutes: z.coerce.number().optional(),
    conditionParams: z.record(z.string(), z.number().finite()).optional(),
    expiresAt: z.string().optional(),
    notifierChannelIds: z.preprocess((i) => {
      if (typeof i === "string") return i === "" ? [] : [i];
      if (Array.isArray(i)) return i.filter((v) => typeof v === "string" && v !== "");
      return [];
    }, z.string().array()),
  })
  .refine((v) => v.scopeType === "all" || Boolean(v.scopeValue), {
    message: "Required",
    path: ["scopeValue"],
  })
  .refine((v) => v.scopeType !== "errorGroup" || parseErrorGroupScope(v.scopeValue), {
    message: "Invalid error group",
    path: ["scopeValue"],
  })
  .refine(
    (v) =>
      v.conditionKind !== "threshold" ||
      (v.operator !== undefined && v.value !== undefined && Boolean(v.windowMinutes)),
    { message: "Set an operator, value, and window", path: ["value"] }
  )
  .refine((v) => v.conditionKind !== "absence" || Boolean(v.quietWindowMinutes), {
    message: "Set a quiet window",
    path: ["quietWindowMinutes"],
  })
  .refine((v) => v.notifierChannelIds.length > 0, {
    message: "Select at least one notifier",
    path: ["notifierChannelIds"],
  })
  .refine((v) => !v.expiresAt || isValidExpiresAt(v.expiresAt), {
    message: "Expiry must be a valid date in the future",
    path: ["expiresAt"],
  });

const ChatFormSchema = z
  .object({
    capabilityKey: z.string().min(1, "Choose a metric"),
    scopeType: ScopeTypeSchema,
    scopeValue: z.string().optional(),
    conditionKind: alertKindSchema,
    operator: z.enum([">", "<"]).optional(),
    value: z.coerce.number().optional(),
    windowMinutes: z.coerce.number().optional(),
    holdMinutes: z.coerce.number().optional(),
    quietWindowMinutes: z.coerce.number().optional(),
    conditionParams: z.record(z.string(), z.number().finite()).optional(),
    expiresAt: z.string().optional(),
    notifierChannelIds: z.preprocess((i) => {
      if (typeof i === "string") return i === "" ? [] : [i];
      if (Array.isArray(i)) return i.filter((v) => typeof v === "string" && v !== "");
      return [];
    }, z.string().array()),
  })
  .refine((v) => v.scopeType === "all" || Boolean(v.scopeValue), {
    message: "Required",
    path: ["scopeValue"],
  })
  .refine((v) => v.scopeType !== "errorGroup" || parseErrorGroupScope(v.scopeValue), {
    message: "Invalid error group",
    path: ["scopeValue"],
  })
  .refine(
    (v) =>
      v.conditionKind !== "threshold" ||
      (v.operator !== undefined && v.value !== undefined && Boolean(v.windowMinutes)),
    { message: "Set an operator, value, and window", path: ["value"] }
  )
  .refine((v) => v.conditionKind !== "absence" || Boolean(v.quietWindowMinutes), {
    message: "Set a quiet window",
    path: ["quietWindowMinutes"],
  })
  .refine(
    (v) => {
      if (!v.expiresAt) return true;
      const date = new Date(v.expiresAt);
      if (Number.isNaN(date.getTime())) return false;
      return date.getTime() > Date.now();
    },
    { message: "Expiry must be in the future", path: ["expiresAt"] }
  );

export const ChatRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    name: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(120).optional()
    ),
    chatNotifier: z.enum(["on"]).optional(),
    chatId: z.string().optional(),
    transcriptChatId: z.string().optional(),
    expiry: z
      .string()
      .regex(/^(none|deploy|incident|\d+h)$/)
      .optional(),
    form: ChatFormSchema,
  })
  .refine((v) => v.chatNotifier !== "on" || Boolean(v.chatId), {
    message: "chatNotifier requires a chatId",
    path: ["chatId"],
  })
  .refine((v) => v.chatNotifier === "on" || v.form.notifierChannelIds.length > 0, {
    message: "At least one notifier is required",
    path: ["form", "notifierChannelIds"],
  });

export function buildScope(v: z.infer<typeof FormSchema>): AlertDraftScope {
  switch (v.scopeType) {
    case "queue":
      return { type: "queue", queue: v.scopeValue! };
    case "queuePattern":
      return { type: "queuePattern", pattern: v.scopeValue! };
    case "task":
      return { type: "task", taskIdentifier: v.scopeValue! };
    case "all":
      return { type: "all" };
    case "errorGroup":
      return parseErrorGroupScope(v.scopeValue)!;
  }
}

export function buildCondition(v: z.infer<typeof FormSchema>): Condition {
  switch (v.conditionKind) {
    case "threshold":
      return {
        kind: "threshold",
        operator: v.operator!,
        value: v.value!,
        windowSec: (v.windowMinutes ?? 0) * 60,
        holdSec: v.holdMinutes ? v.holdMinutes * 60 : undefined,
      };
    case "state":
      return {
        kind: "state",
        stateKey: v.capabilityKey,
        holdSec: v.holdMinutes ? v.holdMinutes * 60 : undefined,
        params: v.conditionParams,
      };
    case "occurrence":
      return { kind: "occurrence" };
    case "absence":
      return { kind: "absence", quietWindowSec: (v.quietWindowMinutes ?? 0) * 60 };
  }
}
