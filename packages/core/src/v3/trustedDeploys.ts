import { z } from "zod/v4";
import { EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH } from "./externalDeploymentId.js";
import {
  CreateArtifactResponseBody,
  InitializeDeploymentResponseBody,
  PromoteDeploymentResponseBody,
} from "./schemas/api.js";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const TRUSTED_DEPLOY_AUDIENCE = "https://api.trigger.dev";

export const MAX_TRUSTED_DEPLOY_CLAIMS = 20;
export const TrustedDeployClaimName = z
  .string()
  .trim()
  .min(1, "Name the claim.")
  .max(100)
  .regex(/^[\w.-]+$/, "Use letters, digits, dots, dashes, or underscores.")
  .refine(
    (name) => !["__proto__", "constructor", "prototype"].includes(name),
    "This claim name is not allowed."
  );
export const TrustedDeployClaimValues = z
  .array(z.string().trim().min(1).max(1024))
  .min(1, "Add at least one accepted value.")
  .max(20);
const AdditionalClaims = z.preprocess(
  (value, ctx) => {
    // Zod records omit __proto__, which must not silently discard a condition.
    if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
      ctx.addIssue({
        code: "custom",
        path: ["__proto__"],
        message: "This claim name is not allowed.",
      });
      return z.NEVER;
    }
    return value;
  },
  z
    .record(TrustedDeployClaimName, TrustedDeployClaimValues)
    .refine(
      (claims) => Object.keys(claims).length <= MAX_TRUSTED_DEPLOY_CLAIMS,
      "Too many additional claims."
    )
);

export const TrustedDeployScope = z.enum(["ANY", "BRANCH", "TAG", "ENVIRONMENT"]);

export const TrustedDeployPolicy = z
  .object({
    scope: TrustedDeployScope,
    scopeValue: z.string().trim().max(255).nullable(),
    additionalClaims: AdditionalClaims,
  })
  .superRefine((policy, ctx) => {
    if (policy.scope === "ANY") {
      if (policy.scopeValue !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["scopeValue"],
          message: "Any scope does not use a name.",
        });
      }
    } else if (!policy.scopeValue) {
      ctx.addIssue({
        code: "custom",
        path: ["scopeValue"],
        message: "Enter a name for this scope.",
      });
    } else if (policy.scope === "BRANCH" || policy.scope === "TAG") {
      if (policy.scopeValue.startsWith("refs/")) {
        ctx.addIssue({
          code: "custom",
          path: ["scopeValue"],
          message: "Enter the name without a refs/heads/ or refs/tags/ prefix.",
        });
      } else if (/[\s?[\]{}()!\\]/.test(policy.scopeValue)) {
        ctx.addIssue({
          code: "custom",
          path: ["scopeValue"],
          message: "Only * wildcards are supported in branch and tag names.",
        });
      }
    }
  });
export type TrustedDeployPolicy = z.infer<typeof TrustedDeployPolicy>;

export const TrustedDeployRepositorySettings = z.object({
  repositoryOwner: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9-]+$/, "Enter a GitHub owner.")
    .max(100),
  repositoryName: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]+$/, "Enter a GitHub repository.")
    .max(100),
  repositoryId: z.string().regex(/^\d+$/, "Use the numeric repository ID.").optional(),
  repositoryOwnerId: z.string().regex(/^\d+$/, "Use the numeric owner ID.").optional(),
});

const TrustedDeployTarget = z.object({
  projectRef: z.string().min(1).max(100),
  env: z.enum(["staging", "preview", "prod"]),
  branch: z.string().min(1).max(255).optional(),
});

export const PrepareTrustedDeployRequest = TrustedDeployTarget.extend({
  contentLength: z.number().int().positive(),
})
  .strict()
  .superRefine(validateBranch);

export const PrepareTrustedDeployResponse = CreateArtifactResponseBody;

export const ArchiveTrustedPreviewRequest = TrustedDeployTarget.extend({
  env: z.literal("preview"),
  branch: z.string().min(1).max(255),
}).strict();
export const ArchiveTrustedPreviewResponse = z.object({ success: z.literal(true) });

export const PromoteTrustedDeploymentRequest = TrustedDeployTarget.extend({
  version: z.string().min(1).max(100),
})
  .strict()
  .superRefine(validateBranch);
export const PromoteTrustedDeploymentResponse = PromoteDeploymentResponseBody;

export const SubmitTrustedDeployRequest = TrustedDeployTarget.extend({
  artifactKey: z.string().min(1).max(1024),
  runtime: z.string().max(50).optional(),
  configFilePath: z.string().min(1).max(1024).optional(),
  skipPromotion: z.boolean().optional(),
  externalId: z.string().trim().min(1).max(EXTERNAL_DEPLOYMENT_ID_MAX_LENGTH).optional(),
  force: z.boolean().optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    validateBranch(value, ctx);
    if (value.force && !value.externalId) {
      ctx.addIssue({ code: "custom", path: ["force"], message: "force requires externalId." });
    }
    if (
      value.configFilePath &&
      (value.configFilePath.startsWith("/") ||
        value.configFilePath.includes("\\") ||
        value.configFilePath.split("/").includes(".."))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["configFilePath"],
        message: "Config must be inside the uploaded workspace.",
      });
    }
  });

export const SubmitTrustedDeployResponse = InitializeDeploymentResponseBody.pick({
  id: true,
  contentHash: true,
  shortCode: true,
  version: true,
  imageTag: true,
  imagePlatform: true,
  externalId: true,
  outcome: true,
  isPromoted: true,
  canceledDeployments: true,
  eventStream: true,
});

function validateBranch(value: z.infer<typeof TrustedDeployTarget>, ctx: z.RefinementCtx) {
  if ((value.env === "preview") !== (value.branch !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["branch"],
      message: "A branch is required only for Preview deployments.",
    });
  }
}

export type PrepareTrustedDeployRequest = z.infer<typeof PrepareTrustedDeployRequest>;
export type SubmitTrustedDeployRequest = z.infer<typeof SubmitTrustedDeployRequest>;
export type SubmitTrustedDeployResponse = z.infer<typeof SubmitTrustedDeployResponse>;
