import { json } from "@remix-run/server-runtime";
import {
  resolveVariablesForEnvironment,
  type RuntimeEnvironmentForEnvRepo,
} from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { EnvironmentKeyUnavailableError } from "./wrapping.server";

// Called before the attempt starts, so an unavailable key consumes no attempt and the start can be retried.
export async function resolveAttemptVariables(
  environment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo
) {
  try {
    return await resolveVariablesForEnvironment(environment, parentEnvironment);
  } catch (error) {
    if (!(error instanceof EnvironmentKeyUnavailableError)) throw error;
    throw json({ error: error.message }, { status: 503 });
  }
}
