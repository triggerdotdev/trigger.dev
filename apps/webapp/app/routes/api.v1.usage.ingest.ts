import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { validateJWTToken } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
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

  const jwt = request.headers.get("x-trigger-jwt");

  if (!jwt) {
    return { status: 401, body: "Unauthorized" };
  }

  logger.debug("Validating JWT", { jwt });

  const jwtPayload = await validateJWTToken(jwt, JWTPayloadSchema);

  const rawJson = await request.json();

  const json = BodySchema.safeParse(rawJson);

  if (!json.success) {
    logger.error("Failed to parse request body", { rawJson });

    return { status: 400, body: "Bad Request" };
  }

  const preset = machinePresetFromName(jwtPayload.machine_preset as MachinePresetName);

  logger.debug("Validated JWT", { jwtPayload, json: json.data, preset });

  if (json.data.durationMs > 10) {
    const costInCents = json.data.durationMs * preset.centsPerMs;

    await prisma.taskRun.update({
      where: {
        id: jwtPayload.run_id,
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

    await reportUsageEvent({
      source: "webapp",
      type: "usage",
      subject: jwtPayload.org_id,
      data: {
        durationMs: json.data.durationMs,
        costInCents: String(costInCents),
      },
    });
  }

  return new Response(null, {
    status: 200,
  });
}
