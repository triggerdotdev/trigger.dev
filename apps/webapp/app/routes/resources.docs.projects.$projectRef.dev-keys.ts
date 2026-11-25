import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { CUSTOM_API_KEY_PRESET_ID, type RbacResource } from "@trigger.dev/plugins";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { createEnvironmentApiKey, isApiKeyUserError } from "~/models/api-key.server";
import { validateApiKeyAccess } from "~/services/apiKeyPresetValidation.server";
import {
  docsKeyAccess,
  docsKeyExpiry,
  docsKeyName,
  parseRequestedAccess,
} from "~/services/docsKeys.server";
import {
  docsCreateKeyRateLimited,
  docsJson,
  docsPreflight,
  docsReaderUserId,
  isDocsOrigin,
} from "~/services/docsReader.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";

const ParamsSchema = z.object({ projectRef: z.string() });

export async function loader({ request }: LoaderFunctionArgs) {
  // Remix routes OPTIONS to the loader. There is no GET: a key is only ever returned on creation.
  if (request.method.toUpperCase() === "OPTIONS") return docsPreflight(request);
  return docsJson(request, { error: "Method Not Allowed" }, 405);
}

/** Create a docs key (a named API key in the dev environment) for the signed-in reader from the
 * docs. The plaintext is in this response only; the docs keep it in sessionStorage for the tab. */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return docsJson(request, { error: "Method Not Allowed" }, 405);
  }
  // CSRF: a credentialed POST is only accepted from the docs. Browsers always send Origin on a
  // cross-origin POST, so a missing or other Origin is refused even with a valid session.
  if (!isDocsOrigin(request.headers.get("Origin"))) {
    return docsJson(request, { error: "Forbidden" }, 403);
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) return docsJson(request, { error: "Invalid params" }, 400);

  // A form body keeps this a simple request (no preflight); no body is the default docs key.
  const form = request.headers.get("Content-Type")?.includes("form")
    ? await request.formData().catch(() => undefined)
    : null;
  if (form === undefined) return docsJson(request, { error: "Invalid body" }, 400);
  const needed = parseRequestedAccess(form?.get("access") ?? null);
  if (needed === undefined) return docsJson(request, { error: "Invalid access" }, 400);

  const auth = await docsReaderUserId(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  const limited = await docsCreateKeyRateLimited(request, userId);
  if (limited) return limited;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: parsed.data.projectRef,
      deletedAt: null,
      organization: { deletedAt: null, members: { some: { userId } } },
    },
    select: { id: true, organizationId: true, externalRef: true },
  });
  if (!project) return docsJson(request, { error: "Not found" }, 404);

  // The same check the API keys page makes before creating a key.
  const session = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  if (!session.ok || !session.ability.can("write", { type: "apiKeys", envType: "DEVELOPMENT" })) {
    return docsJson(request, { error: "Forbidden" }, 403);
  }

  // The reader's own dev environment, not a dev branch.
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      type: "DEVELOPMENT",
      parentEnvironmentId: null,
      archivedAt: null,
      orgMember: { userId },
    },
    select: { id: true },
  });
  if (!environment) return docsJson(request, { error: "No dev environment" }, 404);

  const accessOptions = await rbac.apiKeyAccessOptions(project.organizationId);
  const keyAccess = docsKeyAccess(needed, accessOptions);
  // The docs never create a full-access key. The docs show the API keys page link next to this.
  if (!keyAccess) {
    return docsJson(request, { error: "This operation needs a key from the API keys page." }, 422);
  }

  // Never grant a requested scope the reader's role can't use in the dev environment. The rest of
  // a preset follows the API keys page, where write:apiKeys (checked above) is enough.
  const exceeds = needed?.find((scope) => {
    const [action, type] = scope.split(":");
    return !session.ability.can(action, { type, envType: "DEVELOPMENT" } as RbacResource);
  });
  if (exceeds) {
    return docsJson(request, { error: `Your role can't grant ${exceeds}` }, 403);
  }

  try {
    const access = validateApiKeyAccess({
      presets:
        keyAccess.presetId === CUSTOM_API_KEY_PRESET_ID ? [] : (accessOptions?.presets ?? null),
      presetId: keyAccess.presetId,
      capabilities: keyAccess.capabilities,
      taskIdentifiers: [],
      hasTaskParameters: false,
    });
    const name = docsKeyName(needed);
    const result = await createEnvironmentApiKey({
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId,
      name,
      ...docsKeyExpiry(),
      ...access,
    });
    logger.info("Docs API key created", {
      projectId: project.id,
      environmentId: environment.id,
      userId,
      access: needed,
    });

    return docsJson(request, {
      projectRef: project.externalRef,
      name,
      apiKey: result.plaintext,
      apiUrl: env.API_ORIGIN ?? env.APP_ORIGIN,
      access: needed,
      // What the key can do, so the docs pick it for the endpoints it covers.
      scopes: keyAccess.scopes,
    });
  } catch (error) {
    if (isApiKeyUserError(error)) {
      return docsJson(request, { error: (error as Error).message }, 400);
    }
    logger.error("Failed to create a docs API key", { projectId: project.id, error });
    return docsJson(request, { error: "Could not create a key" }, 500);
  }
}
