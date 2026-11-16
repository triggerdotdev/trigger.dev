import { generateFriendlyId } from "../isomorphic/friendlyId.js";
import { getEnvVar } from "../utils/getEnv.js";

let machineId: string | undefined;

// Generated on first use, not at import, so importing draws no randomness.
export function getMachineId(): string {
  return (machineId ??= getEnvVar("TRIGGER_MACHINE_ID") ?? generateFriendlyId("machine"));
}
