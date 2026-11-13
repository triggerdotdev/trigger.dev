import { CUSTOM_API_KEY_PRESET_ID } from "@trigger.dev/plugins";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import {
  createEnvironmentApiKey,
  disableRootApiKeyVisibility,
  isApiKeyUserError,
  revokeEnvironmentApiKey,
  updateEnvironmentApiKeyAccess,
  updateEnvironmentApiKeyDescription,
  updateEnvironmentApiKeyIpRanges,
} from "~/models/api-key.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  typedJsonWithErrorMessage,
  typedJsonWithSuccessMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  API_KEY_PRESET_PERMISSION_MESSAGE,
  canManageApiKeyPresets,
  validateApiKeyAccess,
} from "~/services/apiKeyPresetValidation.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION } from "~/utils/apiKeyAccess";
import { ApiKeyNoteField } from "~/utils/apiKeyNote";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { splitIpRangesInput } from "~/utils/ipRangeEntries";

const CapabilitiesField = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    try {
      return z.record(z.string(), z.string()).parse(JSON.parse(value));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid capabilities" });
      return z.NEVER;
    }
  });

const AccessFields = {
  presetId: z.string().trim().min(1),
  capabilities: CapabilitiesField,
  taskScope: z.enum(["all", "selected"]).optional(),
  taskIdentifiers: z
    .array(z.string().trim().min(1, "Task identifiers cannot be blank"))
    .max(MAX_API_KEY_TASK_IDENTIFIERS, {
      message: `You can select at most ${MAX_API_KEY_TASK_IDENTIFIERS} tasks`,
    })
    .default([]),
};

const CreateApiKeySchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(64),
  description: ApiKeyNoteField,
  expiresAt: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce
      .date()
      .refine((date) => date.getTime() > Date.now(), "Expiration must be in the future")
      .optional()
  ),
  ...AccessFields,
  allowedIpRanges: z.string().optional(),
});

const ApiKeyActionSchema = z.discriminatedUnion("action", [
  CreateApiKeySchema,
  z.object({ action: z.literal("revoke"), apiKeyId: z.string().min(1) }),
  z.object({ action: z.literal("update-access"), apiKeyId: z.string().min(1), ...AccessFields }),
  z.object({
    action: z.literal("update-description"),
    apiKeyId: z.string().min(1),
    description: ApiKeyNoteField,
  }),
  z.object({
    action: z.literal("update-ip-ranges"),
    apiKeyId: z.string().min(1),
    allowedIpRanges: z.string().default(""),
  }),
  z.object({
    action: z.literal("save-preset"),
    name: z.string(),
    description: z.string().default(""),
    capabilities: CapabilitiesField,
    limitsTasks: z
      .string()
      .optional()
      .transform((value) => value === "true"),
  }),
  z.object({ action: z.literal("delete-preset"), presetId: z.string().min(1) }),
  z.object({
    action: z.literal("disable-root"),
    confirmation: z.literal(DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION),
  }),
]);

const DIALOG_ACTIONS = new Set(["create", "update-access", "save-preset", "delete-preset"]);

export type ApiKeyActionData =
  | { ok: true; action: "create"; apiKey: string }
  | { ok: true; action: "update-access"; apiKeyId: string }
  | { ok: true; action: "save-preset"; presetId: string }
  | { ok: true; action: "delete-preset"; presetId: string }
  | { ok: false; error: string };

export async function canManageOrganizationPresets(
  request: Request,
  userId: string,
  organizationId: string | undefined
) {
  if (!organizationId) return false;
  const auth = await rbac.authenticateSession(request, { userId, organizationId });
  return auth.ok && canManageApiKeyPresets(auth.ability);
}

async function presetsToValidate(organizationId: string, presetId: string | undefined) {
  if (presetId === CUSTOM_API_KEY_PRESET_ID) {
    return (await rbac.isUsingPlugin()) ? [] : null;
  }
  return (await rbac.apiKeyAccessOptions(organizationId))?.presets ?? null;
}

export const apiKeysAction = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // The environment tier is only known after resolving the route params,
    // so write:apiKeys is enforced in the handler before any mutation.
  },
  async ({ request, params, user, ability }) => {
    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response("Environment not found", { status: 404 });
    }

    if (!ability.can("write", { type: "apiKeys", envType: environment.type })) {
      return typedJsonWithErrorMessage(
        { ok: false as const, error: "You don't have permission to manage these API keys." },
        request,
        "You don't have permission to manage these API keys."
      );
    }

    const formData = await request.formData();
    const hasTaskParameters = formData.has("taskScope") || formData.has("taskIdentifiers");
    const submission = ApiKeyActionSchema.safeParse({
      ...Object.fromEntries(formData),
      taskIdentifiers: formData.getAll("taskIdentifiers"),
    });
    if (!submission.success) {
      const error = submission.error.issues[0]?.message ?? "Invalid API key request";
      if (DIALOG_ACTIONS.has(String(formData.get("action")))) {
        return typedjson({ ok: false as const, error });
      }
      return typedJsonWithErrorMessage({ ok: false as const, error }, request, error);
    }

    const keyEnvironmentId = environment.parentEnvironmentId ?? environment.id;
    const returnPath = `${new URL(request.url).pathname}${new URL(request.url).search}`;

    try {
      switch (submission.data.action) {
        case "create": {
          const access = validateApiKeyAccess({
            presets: await presetsToValidate(project.organizationId, submission.data.presetId),
            ...submission.data,
            hasTaskParameters,
          });
          const result = await createEnvironmentApiKey({
            environmentId: keyEnvironmentId,
            taskEnvironmentId: environment.id,
            userId: user.id,
            name: submission.data.name,
            description: submission.data.description,
            expiresAt: submission.data.expiresAt,
            ...access,
            allowedIpRanges: splitIpRangesInput(submission.data.allowedIpRanges),
          });

          return typedJsonWithSuccessMessage(
            {
              ok: true as const,
              action: "create" as const,
              apiKey: result.plaintext,
            },
            request,
            `Created ${submission.data.name} API key`
          );
        }
        case "update-access": {
          const access = validateApiKeyAccess({
            presets: await presetsToValidate(project.organizationId, submission.data.presetId),
            ...submission.data,
            hasTaskParameters,
          });
          await updateEnvironmentApiKeyAccess({
            environmentId: keyEnvironmentId,
            taskEnvironmentId: environment.id,
            userId: user.id,
            apiKeyId: submission.data.apiKeyId,
            ...access,
          });

          return typedJsonWithSuccessMessage(
            {
              ok: true as const,
              action: "update-access" as const,
              apiKeyId: submission.data.apiKeyId,
            },
            request,
            "API key access updated"
          );
        }
        case "save-preset": {
          if (!(await canManageOrganizationPresets(request, user.id, project.organizationId))) {
            return typedjson({ ok: false as const, error: API_KEY_PRESET_PERMISSION_MESSAGE });
          }
          const result = await rbac.createApiKeyPreset({
            organizationId: project.organizationId,
            name: submission.data.name,
            description: submission.data.description,
            capabilities: submission.data.capabilities ?? {},
            limitsTasks: submission.data.limitsTasks,
            createdById: user.id,
          });
          if (!result.ok) {
            return typedjson({ ok: false as const, error: result.error });
          }
          return typedJsonWithSuccessMessage(
            { ok: true as const, action: "save-preset" as const, presetId: result.preset.id },
            request,
            `Saved ${result.preset.label} preset`
          );
        }
        case "delete-preset": {
          if (!(await canManageOrganizationPresets(request, user.id, project.organizationId))) {
            return typedjson({ ok: false as const, error: API_KEY_PRESET_PERMISSION_MESSAGE });
          }
          const result = await rbac.deleteApiKeyPreset({
            organizationId: project.organizationId,
            presetId: submission.data.presetId,
          });
          if (!result.ok) {
            return typedjson({ ok: false as const, error: result.error });
          }
          return typedJsonWithSuccessMessage(
            {
              ok: true as const,
              action: "delete-preset" as const,
              presetId: submission.data.presetId,
            },
            request,
            "Preset deleted"
          );
        }
        case "revoke": {
          await revokeEnvironmentApiKey({
            environmentId: keyEnvironmentId,
            apiKeyId: submission.data.apiKeyId,
          });

          return redirectWithSuccessMessage(returnPath, request, "API key revoked");
        }
        case "update-description": {
          const note = await updateEnvironmentApiKeyDescription({
            environmentId: keyEnvironmentId,
            apiKeyId: submission.data.apiKeyId,
            description: submission.data.description,
          });

          return redirectWithSuccessMessage(
            returnPath,
            request,
            note ? "API key note updated" : "API key note removed"
          );
        }
        case "update-ip-ranges": {
          await updateEnvironmentApiKeyIpRanges({
            environmentId: keyEnvironmentId,
            apiKeyId: submission.data.apiKeyId,
            allowedIpRanges: splitIpRangesInput(submission.data.allowedIpRanges),
          });

          return redirectWithSuccessMessage(returnPath, request, "Allowed IP addresses updated");
        }
        case "disable-root": {
          await disableRootApiKeyVisibility({
            environmentId: keyEnvironmentId,
            userId: user.id,
          });

          return redirectWithSuccessMessage(
            returnPath,
            request,
            "Root API key visibility disabled"
          );
        }
      }
    } catch (error) {
      if (!isApiKeyUserError(error)) {
        logger.error("API keys action failed", {
          action: submission.data.action,
          environmentId: keyEnvironmentId,
          error,
        });
      }
      const message = error instanceof Error ? error.message : "Unable to update API keys";

      if (DIALOG_ACTIONS.has(submission.data.action)) {
        return typedjson({ ok: false as const, error: message });
      }

      return redirectWithErrorMessage(returnPath, request, message);
    }
  }
);
