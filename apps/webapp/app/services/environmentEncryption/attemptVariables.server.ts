import { json } from "@remix-run/server-runtime";
import {
  prepareVariablesForEnvironment,
  type RuntimeEnvironmentForEnvRepo,
} from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { EnvironmentKeyUnavailableError } from "./wrapping.server";
import { environmentEncryptionTelemetry } from "./telemetry.server";

// Called before the attempt starts, so an unavailable key consumes no attempt and the start can be retried.
export async function resolveAttemptVariables(
  environment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo,
  options?: { proxyEnabled?: boolean }
) {
  try {
    return await prepareVariablesForEnvironment(environment, parentEnvironment, options);
  } catch (error) {
    if (!(error instanceof EnvironmentKeyUnavailableError)) throw error;
    environmentEncryptionTelemetry().failures.add(1, { reason: "attempt_start_unavailable" });
    throw json({ error: error.message }, { status: 503 });
  }
}
