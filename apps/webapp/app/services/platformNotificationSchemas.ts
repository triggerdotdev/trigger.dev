import { z } from "zod";
import { normalizeExactSemVer } from "./platformNotificationVersionTargeting";

const DiscoverySchema = z.object({
  filePatterns: z.array(z.string().min(1)).min(1),
  contentPattern: z
    .string()
    .max(200)
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        try {
          new RegExp(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: "contentPattern must be a valid regular expression" }
    ),
  matchBehavior: z.enum(["show-if-found", "show-if-not-found"]),
});

// Constrain URL fields to http/https; `.url()` alone accepts other schemes
// that would be unsafe to render into an `<a href>`.
const httpUrl = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        const proto = new URL(v).protocol;
        return proto === "http:" || proto === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use http or https" }
  );

const ExactSemVerSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => normalizeExactSemVer(value) !== null, {
    message: "minimumCliVersion must be a complete, exact SemVer",
  })
  .transform((value) => normalizeExactSemVer(value)!);

const CardDataV1Schema = z.object({
  type: z.enum(["card", "info", "warn", "error", "success", "changelog"]),
  title: z.string(),
  description: z.string(),
  image: httpUrl.optional(),
  actionLabel: z.string().optional(),
  actionUrl: httpUrl.optional(),
  dismissOnAction: z.boolean().optional(),
  discovery: DiscoverySchema.optional(),
  minimumCliVersion: ExactSemVerSchema.optional(),
});

export const PayloadV1Schema = z.object({
  version: z.literal("1"),
  data: CardDataV1Schema,
});

export type PayloadV1 = z.infer<typeof PayloadV1Schema>;

const SCOPE_REQUIRED_FK: Record<string, "userId" | "organizationId" | "projectId"> = {
  USER: "userId",
  ORGANIZATION: "organizationId",
  PROJECT: "projectId",
};

const ALL_FK_FIELDS = ["userId", "organizationId", "projectId"] as const;
const CLI_ONLY_FIELDS = ["cliMaxDaysAfterFirstSeen", "cliMaxShowCount", "cliShowEvery"] as const;

// Fields shared by every notification write, excluding the schedule (startsAt/endsAt).
// Drafts reuse this set without committing to any dates.
const NotificationContentFields = {
  title: z.string().min(1),
  payload: PayloadV1Schema,
  surface: z.enum(["WEBAPP", "CLI"]),
  scope: z.enum(["USER", "PROJECT", "ORGANIZATION", "GLOBAL"]),
  userId: z.string().optional(),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  priority: z.number().int().default(0),
  cliMaxDaysAfterFirstSeen: z.number().int().positive().optional(),
  cliMaxShowCount: z.number().int().positive().optional(),
  cliShowEvery: z.number().int().min(2).optional(),
};

const NotificationBaseFields = {
  ...NotificationContentFields,
  endsAt: z
    .string()
    .datetime()
    .transform((s) => new Date(s)),
};

export const CreatePlatformNotificationSchema = z
  .object({
    ...NotificationBaseFields,
    startsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s))
      .optional(),
  })
  .superRefine((data, ctx) => {
    validateScopeForeignKeys(data, ctx);
    validateSurfaceFields(data, ctx);
    validatePayloadTypeForSurface(data, ctx);
    validateStartsAt(data, ctx);
    validateEndsAt(data, ctx);
  });

function validateScopeForeignKeys(
  data: { scope: string; userId?: string; organizationId?: string; projectId?: string },
  ctx: z.RefinementCtx
) {
  const requiredFk = SCOPE_REQUIRED_FK[data.scope];

  if (requiredFk && !data[requiredFk]) {
    ctx.addIssue({
      code: "custom",
      message: `${requiredFk} is required when scope is ${data.scope}`,
      path: [requiredFk],
    });
  }

  const forbiddenFks = ALL_FK_FIELDS.filter((fk) => fk !== requiredFk);
  for (const fk of forbiddenFks) {
    if (data[fk]) {
      ctx.addIssue({
        code: "custom",
        message: `${fk} must not be set when scope is ${data.scope}`,
        path: [fk],
      });
    }
  }
}

function validateSurfaceFields(
  data: {
    surface: string;
    payload: PayloadV1;
    cliMaxDaysAfterFirstSeen?: number;
    cliMaxShowCount?: number;
    cliShowEvery?: number;
  },
  ctx: z.RefinementCtx
) {
  if (data.surface !== "WEBAPP") return;

  for (const field of CLI_ONLY_FIELDS) {
    if (data[field] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${field} is not allowed for WEBAPP surface`,
        path: [field],
      });
    }
  }

  if (data.payload.data.minimumCliVersion !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "minimumCliVersion is not allowed for WEBAPP surface",
      path: ["payload", "data", "minimumCliVersion"],
    });
  }
}

function validateStartsAt(data: { startsAt?: Date }, ctx: z.RefinementCtx) {
  if (!data.startsAt) return;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (data.startsAt < oneHourAgo) {
    ctx.addIssue({
      code: "custom",
      message: "startsAt must be within the last hour or in the future",
      path: ["startsAt"],
    });
  }
}

const CLI_TYPES = new Set(["info", "warn", "error", "success"]);
const WEBAPP_TYPES = new Set(["card", "changelog"]);

function validatePayloadTypeForSurface(
  data: { surface: string; payload: PayloadV1 },
  ctx: z.RefinementCtx
) {
  const allowedTypes = data.surface === "CLI" ? CLI_TYPES : WEBAPP_TYPES;
  if (!allowedTypes.has(data.payload.data.type)) {
    ctx.addIssue({
      code: "custom",
      message: `payload.data.type "${data.payload.data.type}" is not allowed for ${data.surface} surface`,
      path: ["payload", "data", "type"],
    });
  }
}

function validateEndsAt(data: { startsAt?: Date; endsAt: Date }, ctx: z.RefinementCtx) {
  const effectiveStart = data.startsAt ?? new Date();
  if (data.endsAt <= effectiveStart) {
    ctx.addIssue({
      code: "custom",
      message: "endsAt must be after startsAt",
      path: ["endsAt"],
    });
  }
}

export type CreatePlatformNotificationInput = z.input<typeof CreatePlatformNotificationSchema>;

// A draft has no schedule yet: startsAt/endsAt are collected at publish time.
export const CreateDraftPlatformNotificationSchema = z
  .object({
    ...NotificationContentFields,
  })
  .superRefine((data, ctx) => {
    validateScopeForeignKeys(data, ctx);
    validateSurfaceFields(data, ctx);
    validatePayloadTypeForSurface(data, ctx);
  });

export type CreateDraftPlatformNotificationInput = z.input<
  typeof CreateDraftPlatformNotificationSchema
>;

// Editing a draft keeps it a draft — content changes only, still no schedule.
export const UpdateDraftPlatformNotificationSchema = z
  .object({
    ...NotificationContentFields,
    id: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    validateScopeForeignKeys(data, ctx);
    validateSurfaceFields(data, ctx);
    validatePayloadTypeForSurface(data, ctx);
  });

export type UpdateDraftPlatformNotificationInput = z.input<
  typeof UpdateDraftPlatformNotificationSchema
>;

// Publishing a draft is where the schedule finally becomes required and validated.
export const PublishDraftPlatformNotificationSchema = z
  .object({
    id: z.string().min(1),
    startsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s)),
    endsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s)),
  })
  .superRefine((data, ctx) => {
    validateStartsAt(data, ctx);
    validateEndsAt(data, ctx);
  });

export type PublishDraftPlatformNotificationInput = z.input<
  typeof PublishDraftPlatformNotificationSchema
>;

export const UpdatePlatformNotificationSchema = z
  .object({
    ...NotificationBaseFields,
    id: z.string().min(1),
    startsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s)),
  })
  .superRefine((data, ctx) => {
    validateScopeForeignKeys(data, ctx);
    validateSurfaceFields(data, ctx);
    validatePayloadTypeForSurface(data, ctx);
    // Existing notifications may have a startsAt in the past.
    validateEndsAt(data, ctx);
  });
