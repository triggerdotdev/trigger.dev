import { withAdminApi } from "~/services/adminApi.server";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { engine } from "~/v3/runEngine.server";

async function handleAction({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    await engine.migrateLegacyMasterQueues();

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}

export const action = withAdminApi(handleAction);
