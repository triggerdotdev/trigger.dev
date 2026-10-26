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
  getAllFlagControlTypes,
  isPlainFlagObject,
  mergeReplacedOrgFlags,
  parseStoredOrgFlags,
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

  const [organization, globalFlags, workerGroups, environments] = await Promise.all([
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
    prisma.runtimeEnvironment.findMany({
      where: {
        organizationId,
        type: { not: "DEVELOPMENT" },
        archivedAt: null,
        isBranchableEnvironment: false,
        project: { deletedAt: null },
      },
      select: {
        id: true,
        type: true,
        branchName: true,
        project: { select: { name: true } },
      },
      orderBy: [{ project: { name: "asc" } }, { type: "asc" }, { branchName: "asc" }],
    }),
  ]);

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const { valid: orgFlags, invalid: invalidOrgFlags } = parseStoredOrgFlags(
    organization.featureFlags
  );
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
    invalidOrgFlags,
    globalFlags,
    controlTypes,
    workerGroupName,
    workerGroups,
    environments: environments.map((environment) => ({
      id: environment.id,
      type: environment.type,
      branchName: environment.branchName,
      projectName: environment.project.name,
    })),
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

  // null (the dialog with nothing set) clears every known flag. Stored keys this release
  // doesn't know survive it, like any other save: the dialog never showed them.
  const requestedBody = body === null ? {} : body;
  if (!isPlainFlagObject(requestedBody)) {
    return json({ error: "Invalid feature flags" }, { status: 400 });
  }

  // Seed the flip baseline from the current GLOBAL mint flags so an org's FIRST per-org override
  // is graced from the currently-effective global kind, not the hardcoded default "cuid".
  const globalFlags = (await getGlobalFlags()) as Record<string, unknown>;

  // Lock the org row for the whole read -> stamp -> write so a concurrent flag save can't clobber
  // the grace metadata (read-then-write race). PK lookup, one row, held to commit.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ featureFlags: unknown }[]>`
      SELECT "featureFlags" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

    if (rows.length === 0) {
      return { status: "not_found" } as const;
    }

    const existingRaw = rows[0].featureFlags as Record<string, unknown> | null;

    // Validated against the stored row, so an unchanged invalid value can be sent back as is.
    const merged = mergeReplacedOrgFlags(requestedBody, existingRaw);
    if (!merged.success) {
      return { status: "rejected", rejectedKeys: merged.rejectedKeys } as const;
    }

    // Derived grace-stamp fields are computed server-side; never trust them from the body.
    const {
      runOpsMintKindPrev: _ignoredPrev,
      runOpsMintKindFlippedAt: _ignoredFlippedAt,
      ...requestedFlags
    } = merged.flags;

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
      data: {
        featureFlags:
          Object.keys(stamped).length === 0 ? Prisma.JsonNull : (stamped as Prisma.InputJsonValue),
      },
    });

    return { status: "updated" } as const;
  });

  if (updated.status === "not_found") {
    throw new Response("Organization not found", { status: 404 });
  }

  if (updated.status === "rejected") {
    return json(
      {
        error: `Invalid feature flags: ${updated.rejectedKeys.join(", ")}`,
        details: updated.rejectedKeys.map((key) => ({ path: [key], message: "Invalid value" })),
      },
      { status: 400 }
    );
  }

  // Org feature flags are embedded in every env of the org; drop all its cached env rows.
  controlPlaneResolver.invalidateOrganization(organizationId);

  return json({ success: true });
}
