import type { SubmissionResult } from "@conform-to/react";
import {
  MAX_TRUSTED_DEPLOY_CLAIMS,
  TrustedDeployClaimName,
  TrustedDeployClaimValues,
  TrustedDeployPolicy,
  TrustedDeployRepositorySettings,
  TrustedDeployScope,
} from "@trigger.dev/core/v3";
import { z } from "zod/v4";

export type SettingsActionData = { formId: string; result: SubmissionResult };

function identityInput(nameSchema: z.ZodString) {
  return z
    .string()
    .trim()
    .refine((value) => {
      const [name, id, ...extra] = value.split("@");
      return (
        nameSchema.safeParse(name).success &&
        (id === undefined || /^\d+$/.test(id)) &&
        extra.length === 0
      );
    }, "Use a name, optionally followed by @ and its numeric GitHub ID.");
}

export const RepositoryFormSchema = z
  .object({
    intent: z.literal("repository"),
    repositoryOwner: identityInput(TrustedDeployRepositorySettings.shape.repositoryOwner),
    repositoryName: identityInput(TrustedDeployRepositorySettings.shape.repositoryName),
  })
  .transform(({ intent, repositoryOwner, repositoryName }) => {
    const [owner, ownerId] = repositoryOwner.split("@");
    const [name, id] = repositoryName.split("@");
    return {
      intent,
      repositoryOwner: owner,
      repositoryOwnerId: ownerId,
      repositoryName: name,
      repositoryId: id,
    };
  });

function splitClaimValues(value?: string) {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const ClaimRow = z
  .object({
    name: z.string().trim().optional(),
    values: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    const name = TrustedDeployClaimName.safeParse(row.name ?? "");
    if (!name.success) {
      ctx.addIssue({ code: "custom", path: ["name"], message: name.error.issues[0].message });
    }
    const values = TrustedDeployClaimValues.safeParse(splitClaimValues(row.values));
    if (!values.success) {
      ctx.addIssue({ code: "custom", path: ["values"], message: values.error.issues[0].message });
    }
  });

export function publishingPolicyFromForm(fields: {
  scope: z.infer<typeof TrustedDeployScope>;
  scopeValue?: string;
  additionalClaims: z.infer<typeof ClaimRow>[];
}) {
  return {
    scope: fields.scope,
    scopeValue: fields.scope === "ANY" ? null : fields.scopeValue?.trim() || null,
    additionalClaims: Object.fromEntries(
      fields.additionalClaims.map((row) => [row.name ?? "", splitClaimValues(row.values)])
    ),
  };
}

export const EnvironmentFormSchema = z
  .object({
    intent: z.literal("environment"),
    repositoryUpdatedAt: z.string().min(1),
    scope: TrustedDeployScope,
    scopeValue: z.string().trim().optional(),
    additionalClaims: z.array(ClaimRow).max(MAX_TRUSTED_DEPLOY_CLAIMS).default([]),
  })
  .superRefine((value, ctx) => {
    const scope = TrustedDeployPolicy.safeParse({
      ...publishingPolicyFromForm(value),
      additionalClaims: {},
    });
    if (!scope.success) {
      for (const issue of scope.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
    const seen = new Set<string>();
    value.additionalClaims.forEach((row, index) => {
      if (row.name && seen.has(row.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["additionalClaims", index, "name"],
          message: "Use one row per claim.",
        });
      }
      if (row.name) seen.add(row.name);
    });
  });
