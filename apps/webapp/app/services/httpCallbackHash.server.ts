import nodeCrypto from "node:crypto";

const PREFIX = "wp1";
const MAX_SCOPED_HASH_LENGTH = 1024;

type CallbackScope = { waitpointId: string; environmentId: string };

/** Carries only the context needed to authenticate before a tenant-gated store read. */
export function generateScopedHttpCallbackHash(scope: CallbackScope, apiKey: string): string {
  const payload = Buffer.from(JSON.stringify([scope.waitpointId, scope.environmentId])).toString(
    "base64url"
  );
  const signed = `${PREFIX}.${payload}`;
  return `${signed}.${nodeCrypto.createHmac("sha256", apiKey).update(signed).digest("hex")}`;
}

/** Untrusted until verifyScopedHttpCallbackHash succeeds; usable only for a control-plane lookup. */
export function readHttpCallbackScope(hash: string): CallbackScope | undefined {
  if (hash.length > MAX_SCOPED_HASH_LENGTH) return;
  const parts = hash.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return;
  if (!/^[a-f0-9]{64}$/.test(parts[2]!)) return;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!Array.isArray(payload) || payload.length !== 2) return;
    if (
      payload.some((value) => typeof value !== "string" || value.length === 0 || value.length > 128)
    )
      return;
    const [waitpointId, environmentId] = payload;
    if (typeof waitpointId !== "string" || typeof environmentId !== "string") return;
    return { waitpointId, environmentId };
  } catch {
    return;
  }
}

export function verifyScopedHttpCallbackHash(
  waitpointId: string,
  environmentId: string,
  hash: string,
  apiKey: string
): boolean {
  const scope = readHttpCallbackScope(hash);
  if (!scope || scope.waitpointId !== waitpointId || scope.environmentId !== environmentId)
    return false;
  const [version, payload, signature] = hash.split(".");
  const expected = nodeCrypto.createHmac("sha256", apiKey).update(`${version}.${payload}`).digest();
  return nodeCrypto.timingSafeEqual(Buffer.from(signature!, "hex"), expected);
}
