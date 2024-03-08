import { depot } from "@depot/sdk-node";
import { env } from "~/env.server";

export async function createRemoteImageBuild() {
  if (!env.DEPOT_TOKEN || !env.DEPOT_PROJECT_ID) {
    return;
  }

  const result = await depot.build.v1.BuildService.createBuild(
    { projectId: env.DEPOT_PROJECT_ID },
    {
      headers: {
        Authorization: `Bearer ${env.DEPOT_TOKEN}`,
      },
    }
  );

  return {
    projectId: env.DEPOT_PROJECT_ID,
    buildToken: result.buildToken,
    buildId: result.buildId,
  };
}
