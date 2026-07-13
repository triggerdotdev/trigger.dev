import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { applyGlobalMintKindFlip, makeSetMultipleFlags } from "~/v3/featureFlags.server";
import { validatePartialFeatureFlags } from "~/v3/featureFlags";

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

    // A global mint-kind flip stamps its grace window under a lock (applyGlobalMintKindFlip);
    // any other flag save writes directly.
    const updatedFlags =
      requestedFlags.runOpsMintKind !== undefined
        ? await applyGlobalMintKindFlip(prisma, requestedFlags, env.RUN_OPS_MINT_FLIP_GRACE_MS)
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
