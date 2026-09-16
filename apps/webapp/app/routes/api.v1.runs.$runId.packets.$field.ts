import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl, jsonPacketPresignFailure } from "~/v3/objectStore.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  runId: z.string(),
  field: z.enum(["payload", "output"]),
});

const select = {
  friendlyId: true,
  taskIdentifier: true,
  runTags: true,
  payload: true,
  payloadType: true,
  output: true,
  outputType: true,
  batch: { select: { friendlyId: true } },
} as const;

function storedPacketPath(
  run: { payload: string; payloadType: string; output: string | null; outputType: string },
  field: "payload" | "output"
): string | null {
  const [data, dataType] =
    field === "payload" ? [run.payload, run.payloadType] : [run.output, run.outputType];
  return dataType === "application/store" && data ? data : null;
}

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
      const args = { select };

      // The replica may not have the stored output yet for a run that just completed.
      let run = await runStore.findRun(where, args, $replica);
      if (!run || !storedPacketPath(run, params.field)) {
        run = await runStore.findRunOnPrimary(where, args);
      }
      if (!run) return null;

      const packetPath = storedPacketPath(run, params.field);
      return packetPath ? { ...run, packetPath } : null;
    },
    authorization: {
      action: "read",
      resource: (run) =>
        anyResource([
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
          ...(run.batch ? [{ type: "batch", id: run.batch.friendlyId }] : []),
        ]),
    },
  },
  async ({ authentication, resource }) => {
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
