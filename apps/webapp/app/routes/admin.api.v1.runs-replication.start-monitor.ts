import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { startTcpBufferMonitor } from "~/services/monitorTcpBuffers.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { getTcpMonitorGlobal, setTcpMonitorGlobal } from "~/services/runsReplicationGlobal.server";

const schema = z.object({
  intervalMs: z.number().min(1000).max(60_000).default(5_000),
});

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
    const body = await request.json();
    const { intervalMs } = schema.parse(body);

    const globalMonitor = getTcpMonitorGlobal();

    if (globalMonitor) {
      return json(
        {
          error: "Tcp buffer monitor already running, you must stop it before starting a new one",
        },
        {
          status: 400,
        }
      );
    }

    setTcpMonitorGlobal(startTcpBufferMonitor(intervalMs));

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
