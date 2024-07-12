import { json ,type  LoaderFunctionArgs  } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { YaltApiClient } from "@trigger.dev/yalt";
import { logger } from "~/services/logger.server";
import { prisma } from "~/db.server";

// This is for HEAD requests to check if the API supports tunneling
export async function loader({ request }: LoaderFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!env.TUNNEL_HOST || !env.TUNNEL_SECRET_KEY) {
    return json({ error: "Tunneling is not supported" }, { status: 501 });
  }

  return json({ ok: true });
}

export async function action({ request }: LoaderFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (authenticationResult.environment.type !== "DEVELOPMENT") {
    return json({ error: "Tunneling is only supported in development" }, { status: 501 });
  }

  if (!env.TUNNEL_HOST || !env.TUNNEL_SECRET_KEY) {
    return json({ error: "Tunneling is not supported" }, { status: 501 });
  }

  const yaltClient = new YaltApiClient(env.TUNNEL_HOST, env.TUNNEL_SECRET_KEY);

  let tunnelId = authenticationResult.environment.tunnelId;

  if (!tunnelId) {
    try {
      tunnelId = await yaltClient.createTunnel();

      await prisma.runtimeEnvironment.update({
        where: {
          id: authenticationResult.environment.id,
        },
        data: {
          tunnelId,
        },
      });
    } catch (error) {
      logger.error("Failed to create tunnel", { error });

      return json({ error: "Failed to create tunnel" }, { status: 500 });
    }
  }

  if (!tunnelId) {
    return json({ error: "Failed to create tunnel" }, { status: 500 });
  }

  return json({ url: yaltClient.connectUrl(tunnelId) });
}
