import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  applyGlobalGracedFlips,
  makeSetMultipleFlags,
  touchesGracedGroup,
  withoutDerivedKeys,
} from "~/v3/featureFlags.server";
import { validatePartialFeatureFlags } from "~/v3/featureFlags";
import { snapshotStoreFlagSaveError } from "~/v3/snapshotStoreFlagGuard.server";

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

    const snapshotStoreError = snapshotStoreFlagSaveError(body as Record<string, unknown>, {
      redisHostConfigured: !!env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST,
    });
    if (snapshotStoreError) {
      return json({ error: snapshotStoreError }, { status: 400 });
    }

    // Both the strip and the branch derive from the graced-group table, so adding a group needs
    // no edit here. Naming the keys inline is how a new group ends up writing its stamp straight
    // from the request body, with no lock.
    const requestedFlags = withoutDerivedKeys(validationResult.data) as Partial<
      typeof validationResult.data
    >;

    const updatedFlags = touchesGracedGroup(requestedFlags)
      ? await applyGlobalGracedFlips(prisma, requestedFlags, env.RUN_OPS_MINT_FLIP_GRACE_MS)
      : await makeSetMultipleFlags(prisma)(requestedFlags);

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
