import { withAdminApi } from "~/services/adminApi.server";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  getRunsReplicationGlobal,
  unregisterRunsReplicationGlobal,
} from "~/services/runsReplicationGlobal.server";
import { runsReplicationInstance } from "~/services/runsReplicationInstance.server";

async function handleAction({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    const globalService = getRunsReplicationGlobal();

    if (globalService) {
      await globalService.teardown();
      unregisterRunsReplicationGlobal();
    } else {
      await runsReplicationInstance?.teardown();
    }

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}

export const action = withAdminApi(handleAction);
