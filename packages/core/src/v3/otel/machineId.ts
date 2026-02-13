import { generateFriendlyId } from "../isomorphic/friendlyId.js";
import { getEnvVar } from "../utils/getEnv.js";

export const machineId = getEnvVar("TRIGGER_MACHINE_ID") ?? generateFriendlyId("machine");
