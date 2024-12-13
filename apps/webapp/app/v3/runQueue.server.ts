import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "./marqs/index.server";
import { engine } from "./runEngine.server";

//This allows us to update MARQS and the RunQueue

/** Updates MARQS and the RunQueue limits */
export async function updateEnvConcurrencyLimits(environment: AuthenticatedEnvironment) {
  await Promise.allSettled([
    marqs?.updateEnvConcurrencyLimits(environment),
    engine.runQueue.updateEnvConcurrencyLimits(environment),
  ]);
}

