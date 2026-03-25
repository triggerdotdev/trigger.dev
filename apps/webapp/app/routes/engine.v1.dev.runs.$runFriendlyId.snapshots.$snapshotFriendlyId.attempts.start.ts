import { json, TypedResponse } from "@remix-run/server-runtime";
import { MachinePreset, SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import {
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { RuntimeEnvironment } from "@trigger.dev/database";
import { defaultMachine } from "~/services/platform.v3.server";
import { z } from "zod";
import { prisma } from "~/db.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  createActionApiRoute,
  createActionWorkerApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: WorkerApiRunAttemptStartRequestBody,
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    method: "POST",
  },
  async ({
    authentication,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiRunAttemptStartResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    try {
      const run = await prisma.taskRun.findFirst({
        where: {
          friendlyId: params.runFriendlyId,
          runtimeEnvironmentId: authentication.environment.id,
        },
      });

      if (!run) {
        throw new Response("You don't have permissions for this run", { status: 401 });
      }

      const engineResult = await engine.startRunAttempt({
        runId: RunId.toId(runFriendlyId),
        snapshotId: SnapshotId.toId(snapshotFriendlyId),
      });

      const defaultMachinePreset = machinePresetFromName(defaultMachine);

      const envVars = await getEnvVars(
        authentication.environment,
        engineResult.run.id,
        engineResult.execution.machine ?? defaultMachinePreset,
        engineResult.run.taskEventStore
      );

      return json({
        ...engineResult,
        envVars,
      });
    } catch (error) {
      logger.error("Failed to record dev log", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

async function getEnvVars(
  environment: RuntimeEnvironment,
  runId: string,
  machinePreset: MachinePreset,
  taskEventStore?: string
): Promise<Record<string, string>> {
  const variables = await resolveVariablesForEnvironment(environment);

  const jwt = await generateJWTTokenForEnvironment(environment, {
    run_id: runId,
    machine_preset: machinePreset.name,
  });

  variables.push(
    ...[
      { key: "TRIGGER_JWT", value: jwt },
      { key: "TRIGGER_RUN_ID", value: runId },
      { key: "TRIGGER_MACHINE_PRESET", value: machinePreset.name },
    ]
  );

  if (taskEventStore) {
    const resourceAttributes = JSON.stringify({
      [SemanticInternalAttributes.TASK_EVENT_STORE]: taskEventStore,
    });

    variables.push(
      ...[
        { key: "OTEL_RESOURCE_ATTRIBUTES", value: resourceAttributes },
        { key: "TRIGGER_OTEL_RESOURCE_ATTRIBUTES", value: resourceAttributes },
      ]
    );
  }

  return variables.reduce((acc: Record<string, string>, curr) => {
    acc[curr.key] = curr.value;
    return acc;
  }, {});
}

export { action };
