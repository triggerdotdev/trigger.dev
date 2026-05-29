import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";
import { FEATURE_FLAG, validatePartialFeatureFlags, getAllFlagControlTypes } from "~/v3/featureFlags";
import { featuresForRequest } from "~/features.server";

// Session-auth route for the admin feature flags dialog.
// Uses replace semantics: the action writes the full flag set (or null to clear).
// Compare with v1 (admin.api.v1.orgs.$organizationId.feature-flags.ts) which
// uses PAT auth and merge semantics for programmatic use.

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  const [organization, globalFlags, workerGroups] = await Promise.all([
    prisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        id: true,
        title: true,
        slug: true,
        featureFlags: true,
      },
    }),
    getGlobalFlags(),
    prisma.workerInstanceGroup.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const orgFlagsResult = organization.featureFlags
    ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
    : ({ success: false } as const);

  const orgFlags = orgFlagsResult.success ? orgFlagsResult.data : {};
  const controlTypes = getAllFlagControlTypes();

  // Resolve worker group name for display
  const workerGroupId = (globalFlags as Record<string, unknown>)?.[
    FEATURE_FLAG.defaultWorkerInstanceGroupId
  ];
  let workerGroupName: string | undefined;
  if (typeof workerGroupId === "string") {
    const wg = await prisma.workerInstanceGroup.findFirst({
      where: { id: workerGroupId },
      select: { name: true },
    });
    workerGroupName = wg?.name;
  }

  const { isManagedCloud } = featuresForRequest(request);

  return json({
    org: {
      id: organization.id,
      title: organization.title,
      slug: organization.slug,
    },
    orgFlags,
    globalFlags,
    controlTypes,
    workerGroupName,
    workerGroups,
    isManagedCloud,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let featureFlags: typeof Prisma.JsonNull | Record<string, unknown>;

  if (
    body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
  ) {
    featureFlags = Prisma.JsonNull;
  } else {
    const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
    if (!validationResult.success) {
      return json(
        { error: "Invalid feature flags", details: validationResult.error.issues },
        { status: 400 }
      );
    }
    featureFlags = validationResult.data;
  }

  try {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { featureFlags: featureFlags as Prisma.InputJsonValue },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new Response("Organization not found", { status: 404 });
    }
    throw e;
  }

  return json({ success: true });
}
