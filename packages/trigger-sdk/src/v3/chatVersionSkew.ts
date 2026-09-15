import { tryCatch } from "@trigger.dev/core/v3";

export type ChatVersionSkewPolicy = "follow" | "hold";

export type SessionVersionPin = {
  externalDeploymentId?: string | null;
  lockToVersion?: string;
};

export type ResolvePinToFollowOptions = {
  policy: ChatVersionSkewPolicy | undefined;
  deployedExternalId: string | undefined;
  upgradeAlreadyRequested: boolean;
  readPin: () => Promise<SessionVersionPin | undefined>;
};

export async function resolvePinToFollow(
  options: ResolvePinToFollowOptions
): Promise<string | undefined> {
  if (options.policy === "hold") {
    return undefined;
  }

  if (options.upgradeAlreadyRequested) {
    return undefined;
  }

  if (!options.deployedExternalId) {
    return undefined;
  }

  const [error, pin] = await tryCatch(options.readPin());

  if (error || !pin) {
    return undefined;
  }

  if (!pin.externalDeploymentId) {
    return undefined;
  }

  if (pin.lockToVersion) {
    return undefined;
  }

  if (pin.externalDeploymentId === options.deployedExternalId) {
    return undefined;
  }

  return pin.externalDeploymentId;
}
