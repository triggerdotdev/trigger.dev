import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { selectMintBaselineSource, stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";
import {
  FEATURE_FLAG,
  validatePartialFeatureFlags,
  getAllFlagControlTypes,
} from "~/v3/featureFlags";
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

  if (
    body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
  ) {
    // Clear all flags. No grace stamp (nothing to flip) and no read-then-write race.
    try {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { featureFlags: Prisma.JsonNull },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new Response("Organization not found", { status: 404 });
      }
      throw e;
    }

    controlPlaneResolver.invalidateOrganization(organizationId);
    return json({ success: true });
  }

  const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
  if (!validationResult.success) {
    return json(
      { error: "Invalid feature flags", details: validationResult.error.issues },
      { status: 400 }
    );
  }

  // Derived grace-stamp fields are computed server-side; never trust them from the body.
  const {
    runOpsMintKindPrev: _ignoredPrev,
    runOpsMintKindFlippedAt: _ignoredFlippedAt,
    ...requestedFlags
  } = validationResult.data;

  // Seed the flip baseline from the current GLOBAL mint flags so an org's FIRST per-org override
  // is graced from the currently-effective global kind, not the hardcoded default "cuid".
  const globalFlags = (await getGlobalFlags()) as Record<string, unknown>;

  // Lock the org row for the whole read -> stamp -> write so a concurrent flag save can't clobber
  // the grace metadata (read-then-write race). PK lookup, one row, held to commit.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ featureFlags: unknown }[]>`
      SELECT "featureFlags" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

    if (rows.length === 0) {
      return false;
    }

    const existingRaw = rows[0].featureFlags as Record<string, unknown> | null;

    // Anchor the flip stamp to the control-plane DB clock (see the v1 route), not this process's.
    const [{ now: controlPlaneNow }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

    const stamped = stampMintKindFlip(
      selectMintBaselineSource(existingRaw, globalFlags),
      requestedFlags,
      controlPlaneNow.getTime(),
      env.RUN_OPS_MINT_FLIP_GRACE_MS
    );

    await tx.organization.update({
      where: { id: organizationId },
      data: { featureFlags: stamped as Prisma.InputJsonValue },
    });

    return true;
  });

  if (!updated) {
    throw new Response("Organization not found", { status: 404 });
  }

  // Org feature flags are embedded in every env of the org; drop all its cached env rows.
  controlPlaneResolver.invalidateOrganization(organizationId);

  return json({ success: true });
}
