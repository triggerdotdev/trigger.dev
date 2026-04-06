import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { getRunsReplicationGlobal } from "~/services/runsReplicationGlobal.server";
import { runsReplicationInstance } from "~/services/runsReplicationInstance.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    const globalService = getRunsReplicationGlobal();

    await clickhouseFactory.isReady();

    if (globalService) {
      await globalService.start();
    } else {
      await runsReplicationInstance?.start();
    }

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
