import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { makeSetMultipleFlags } from "~/v3/featureFlags.server";
import {
  FEATURE_FLAG,
  type FeatureFlagCatalog,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    // Parse the request body
    const body = await request.json();

    // Validate the input using the partial schema
    const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
    if (!validationResult.success) {
      return json(
        {
          error: "Invalid feature flags data",
          details: validationResult.error.issues,
        },
        { status: 400 }
      );
    }

    // Derived grace-stamp fields are computed server-side; never trust them from the body.
    const {
      runOpsMintKindPrev: _ignoredPrev,
      runOpsMintKindFlippedAt: _ignoredFlippedAt,
      ...requestedFlags
    } = validationResult.data;

    let flagsToWrite: Partial<FeatureFlagCatalog> = requestedFlags;

    if (requestedFlags.runOpsMintKind !== undefined) {
      // Read the current GLOBAL mint flags so the stamp is computed against the authoritative
      // stored state, mirroring the per-org route. stampMintKindFlip writes prev/flippedAt only
      // on a genuine global flip, and carries an in-flight stamp forward on a same-target save.
      const existingRows = await prisma.featureFlag.findMany({
        where: {
          key: {
            in: [
              FEATURE_FLAG.runOpsMintKind,
              FEATURE_FLAG.runOpsMintKindPrev,
              FEATURE_FLAG.runOpsMintKindFlippedAt,
            ],
          },
        },
        select: { key: true, value: true },
      });
      const existingGlobal: Record<string, unknown> = {};
      for (const row of existingRows) {
        existingGlobal[row.key] = row.value;
      }

      // Anchor the cutover to the control-plane DB clock, not this process's wall clock.
      const [{ now: controlPlaneNow }] = await prisma.$queryRaw<
        { now: Date }[]
      >`SELECT now() AS now`;

      flagsToWrite = stampMintKindFlip(
        existingGlobal,
        { ...requestedFlags },
        controlPlaneNow.getTime(),
        env.RUN_OPS_MINT_FLIP_GRACE_MS
      ) as Partial<FeatureFlagCatalog>;
    }

    const setMultipleFlags = makeSetMultipleFlags(prisma);
    const updatedFlags = await setMultipleFlags(flagsToWrite);

    return json({
      success: true,
      updatedFlags,
      message: `Updated ${updatedFlags.length} feature flag(s)`,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 }
    );
  }
}
