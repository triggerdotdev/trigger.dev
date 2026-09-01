import type { S2 } from "@s2-dev/streamstore";
import { env } from "~/env.server";
import { buildDeploymentS2Client } from "~/v3/s2ClientConfig";

export function createDeploymentS2Client(): S2 | undefined {
  if (env.S2_ENABLED !== "1") {
    return undefined;
  }

  return buildDeploymentS2Client({
    accessToken: env.S2_ACCESS_TOKEN,
    endpoint: env.S2_DEPLOYMENT_ENDPOINT,
  });
}
