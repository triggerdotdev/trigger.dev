import { createHash } from "node:crypto";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { customAlphabet } from "nanoid";

const apiKeyId = customAlphabet(
  "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  24
);

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function generatedApiKey(apiKey: string) {
  return {
    apiKey,
    keyHash: hashApiKey(apiKey),
    lastFour: apiKey.slice(-4),
  };
}

export function generateRootApiKey(environmentType: RuntimeEnvironmentType) {
  // Root keys intentionally use the same 24-character entropy as additional keys.
  return generatedApiKey(`${apiKeyPrefix(environmentType)}${apiKeyId()}`);
}

export function generateAdditionalApiKey(environmentType: RuntimeEnvironmentType) {
  return generatedApiKey(`${apiKeyPrefix(environmentType)}sk_${apiKeyId()}`);
}

export function apiKeyPrefix(environmentType: RuntimeEnvironmentType): string {
  switch (environmentType) {
    case "DEVELOPMENT":
      return "tr_dev_";
    case "STAGING":
      return "tr_stg_";
    case "PRODUCTION":
      return "tr_prod_";
    case "PREVIEW":
      return "tr_preview_";
  }
}

export function obfuscateApiKey(
  environmentType: RuntimeEnvironmentType,
  lastFour: string,
  kind: "root" | "additional" = "root"
): string {
  const discriminator = kind === "additional" ? "sk_" : "";
  return `${apiKeyPrefix(environmentType)}${discriminator}••••••••${lastFour}`;
}
