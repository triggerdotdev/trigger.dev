import { json } from "@remix-run/server-runtime";
import type { EnvVarGrant } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { recordSecretProxyDelivery } from "../secretProxy/telemetry.server";
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
  options?: { grant?: EnvVarGrant }
) {
  try {
    const prepared = await prepareVariablesForEnvironment(environment, parentEnvironment, options);
    recordSecretProxyDelivery(
      "prepare",
      env.SECRET_PROXY_ENABLED,
      prepared.proxyValues.length ? "protected" : "ordinary"
    );
    return prepared;
  } catch (error) {
    recordSecretProxyDelivery("prepare", env.SECRET_PROXY_ENABLED, "error");
    if (!(error instanceof EnvironmentKeyUnavailableError)) throw error;
    environmentEncryptionTelemetry().failures.add(1, { reason: "attempt_start_unavailable" });
    throw json({ error: error.message }, { status: 503 });
  }
}
