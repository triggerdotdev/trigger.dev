import { type InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import type { StoredEnvironmentValue } from "~/services/environmentEncryption/crypto.server";
import { ServiceValidationError } from "../baseService.server";

/** The envelope stored on a bundle deployment: the redeploy source's copy, or the payload's vars encrypted. */
export async function buildEnvVarsEnvelope(
  payload: InitializeDeploymentRequestBody,
  options: {
    copyFrom?: StoredEnvironmentValue;
    encrypt: (plaintext: string) => StoredEnvironmentValue;
    decryptSource?: (value: StoredEnvironmentValue) => Promise<string>;
    maxKeys: number;
    maxBytes: number;
  }
): Promise<StoredEnvironmentValue | undefined> {
  if (!payload.isNativeBuild || !payload.fromBundle) return undefined;
  if (options.copyFrom) {
    if (!options.decryptSource) throw new Error("Missing source deployment encryption context");
    return options.encrypt(await options.decryptSource(options.copyFrom));
  }

  // Stored even when empty: redeploying a bundle requires its envelope
  const buildEnvVars = payload.buildEnvVars ?? {};

  const keyCount = Object.keys(buildEnvVars).length;
  if (keyCount > options.maxKeys) {
    throw new ServiceValidationError(
      `Build environment variable count (${keyCount}) exceeds the allowed limit of ${options.maxKeys}. Reach out to us if you are seeing this error consistently.`
    );
  }

  const serialized = JSON.stringify(buildEnvVars);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > options.maxBytes) {
    const sizeKB = parseFloat((serializedBytes / 1024).toFixed(1));
    const limitKB = parseFloat((options.maxBytes / 1024).toFixed(1));
    throw new ServiceValidationError(
      `Build environment variables size (${sizeKB} KB) exceeds the allowed limit of ${limitKB} KB. Reach out to us if you are seeing this error consistently.`
    );
  }

  return options.encrypt(serialized);
}
