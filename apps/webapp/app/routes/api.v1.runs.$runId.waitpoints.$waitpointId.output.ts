import { json } from "@remix-run/server-runtime";
import type { RbacResource } from "@trigger.dev/plugins";
import { z } from "zod";
import { $replica } from "~/db.server";
import { assertPacketNamespaceAccess } from "~/services/packetApi.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl, jsonPacketPresignFailure } from "~/v3/objectStore.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  runId: z.string(),
  waitpointId: z.string(),
});

/**
 * Presigned GET URL for the offloaded output of a waitpoint the run just resumed from, authorized
 * against the run. The stored path comes from the run's latest snapshot, never from the caller.
 */
export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) => {
      const where = {
        friendlyId: params.runId,
        runtimeEnvironmentId: authentication.environment.id,
      };
      const select = { select: { id: true, friendlyId: true, taskIdentifier: true } };
      const run =
        (await runStore.findRun(where, select, $replica)) ??
        (await runStore.findRunOnPrimary(where, select));
      if (!run) return null;

      const execution = await engine.getRunExecutionData({
        runId: run.id,
        environmentId: authentication.environment.id,
      });
      const waitpoint = execution?.completedWaitpoints.find(
        (completed) => completed.friendlyId === params.waitpointId
      );
      if (!waitpoint?.output || waitpoint.outputType !== "application/store") return null;

      return {
        ...run,
        packetPath: waitpoint.output,
        readResources: [
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
        ] satisfies RbacResource[],
      };
    },
    authorization: {
      action: "read",
      resource: (run) => anyResource([...run.readResources, { type: "packets" }]),
    },
  },
  async ({ authentication, resource, ability }) => {
    if (!ability.can("read", resource.readResources)) {
      assertPacketNamespaceAccess(authentication);
    }
    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      resource.packetPath,
      "GET"
    );

    if (!signed.success) {
      return jsonPacketPresignFailure(signed);
    }

    return json({ presignedUrl: signed.url });
  }
);
