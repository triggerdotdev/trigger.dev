import { parseWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import nodeCrypto from "node:crypto";
import { env } from "~/env.server";
import { generateScopedHttpCallbackHash } from "./httpCallbackHash.server";

export function generateHttpCallbackUrl(
  waitpointId: string,
  apiKey: string,
  scope?: { environmentId: string }
) {
  const parsed = scope ? parseWaitpointId(waitpointId) : undefined;
  const hash =
    scope &&
    parsed &&
    parsed.format !== "legacy" &&
    (parsed.type === "DATETIME" || parsed.type === "MANUAL")
      ? generateScopedHttpCallbackHash({ waitpointId, environmentId: scope.environmentId }, apiKey)
      : generateHttpCallbackHash(waitpointId, apiKey);

  return `${env.API_ORIGIN ?? env.APP_ORIGIN}/api/v1/waitpoints/tokens/${WaitpointId.toFriendlyId(
    waitpointId
  )}/callback/${hash}`;
}

function generateHttpCallbackHash(waitpointId: string, apiKey: string) {
  const hmac = nodeCrypto.createHmac("sha256", apiKey);
  hmac.update(waitpointId);
  return hmac.digest("hex");
}

export function verifyHttpCallbackHash(waitpointId: string, hash: string, apiKey: string) {
  const expectedHash = generateHttpCallbackHash(waitpointId, apiKey);

  if (
    hash.length === expectedHash.length &&
    nodeCrypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"))
  ) {
    return true;
  }

  return false;
}
