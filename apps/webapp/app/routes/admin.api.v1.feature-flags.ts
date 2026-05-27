import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { makeSetMultipleFlags } from "~/v3/featureFlags.server";
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

    const featureFlags = validationResult.data;
    const setMultipleFlags = makeSetMultipleFlags(prisma);
    const updatedFlags = await setMultipleFlags(featureFlags);

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
