import type { RuntimeEnvironmentType } from "@trigger.dev/database";

const DEVELOPMENT_METERING_REGION = "local";

type MeteringClaimsInput = {
  environmentType: RuntimeEnvironmentType;
  region?: string | null;
  workerQueue?: string | null;
};

export function regionForMetering(
  region: string | null | undefined,
  workerQueue: string | null | undefined
): string | undefined {
  if (region) {
    return region;
  }

  if (!workerQueue) {
    return undefined;
  }

  const colon = workerQueue.indexOf(":");
  return colon === -1 ? workerQueue : workerQueue.slice(0, colon);
}

export function meteringClaims({
  environmentType,
  region,
  workerQueue,
}: MeteringClaimsInput): Record<string, string> {
  const claims = { environment_type: environmentType.toLowerCase() };

  if (environmentType === "DEVELOPMENT") {
    return { ...claims, region: DEVELOPMENT_METERING_REGION };
  }

  const resolvedRegion = regionForMetering(region, workerQueue);

  if (!resolvedRegion) {
    return claims;
  }

  return { ...claims, region: resolvedRegion };
}
