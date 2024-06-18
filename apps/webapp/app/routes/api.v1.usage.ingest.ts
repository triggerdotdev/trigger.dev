import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { validateJWTTokenAndRenew } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "~/services/worker.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { reportUsageEvent } from "~/v3/openMeter.server";

const JWTPayloadSchema = z.object({
  environment_id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  run_id: z.string(),
  machine_preset: z.string(),
});

const BodySchema = z.object({
  durationMs: z.number(),
});

export async function action({ request }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const jwtResult = await validateJWTTokenAndRenew(request, JWTPayloadSchema);

  if (!jwtResult) {
    return { status: 401, body: "Unauthorized" };
  }

  const rawJson = await request.json();

  const json = BodySchema.safeParse(rawJson);

  if (!json.success) {
    logger.error("Failed to parse request body", { rawJson });

    return { status: 400, body: "Bad Request" };
  }

  const preset = machinePresetFromName(jwtResult.payload.machine_preset as MachinePresetName);

  logger.debug("[/api/v1/usage/ingest] Reporting usage", { jwtResult, json: json.data, preset });

  if (json.data.durationMs > 0) {
    const costInCents = json.data.durationMs * preset.centsPerMs;

    await prisma.taskRun.update({
      where: {
        id: jwtResult.payload.run_id,
      },
      data: {
        usageDurationMs: {
          increment: json.data.durationMs,
        },
        costInCents: {
          increment: json.data.durationMs * preset.centsPerMs,
        },
      },
    });

    try {
      await reportUsageEvent({
        source: "webapp",
        type: "usage",
        subject: jwtResult.payload.org_id,
        data: {
          durationMs: json.data.durationMs,
          costInCents: String(costInCents),
        },
      });
    } catch (e) {
      logger.error("Failed to report usage event, enqueing v3.reportUsage", { error: e });

      await workerQueue.enqueue("v3.reportUsage", {
        orgId: jwtResult.payload.org_id,
        data: {
          costInCents: String(costInCents),
        },
        additionalData: {
          durationMs: json.data.durationMs,
        },
      });
    }
  }

  return new Response(null, {
    status: 200,
    headers: {
      "x-trigger-jwt": jwtResult.jwt,
    },
  });
}
