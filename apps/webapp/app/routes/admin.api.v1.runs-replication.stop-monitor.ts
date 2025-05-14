import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import {
  getTcpMonitorGlobal,
  unregisterTcpMonitorGlobal,
} from "~/services/runsReplicationGlobal.server";

export async function action({ request }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  try {
    const globalMonitor = getTcpMonitorGlobal();

    if (!globalMonitor) {
      return json({ error: "Tcp buffer monitor not running" }, { status: 400 });
    }

    clearInterval(globalMonitor);
    unregisterTcpMonitorGlobal();

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
