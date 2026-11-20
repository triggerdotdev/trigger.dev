import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { EffectiveEnvironmentVariable } from "./variables.server";
import type { SecretProxyFailureReason } from "./telemetry.server";

const MAX_KEY_ID_LENGTH = 32;
const KeyId = z
  .string()
  .min(1)
  .max(MAX_KEY_ID_LENGTH)
  .regex(/^[A-Za-z0-9-]+$/);
const Keyring = z
  .object({
    activeKeyId: KeyId,
    keys: z.record(KeyId, z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();
const MAX_RETAINED_KEYS = 8;
const MAX_EXECUTION_HOSTS = 256;
export const SECRET_PROXY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const SECRET_PROXY_MAX_CREDENTIAL_BYTES = 64 * 1024;
export type SecretProxySelection = { handle: string; hostname: string };
export class SecretProxyDeniedError extends Error {
  constructor(
    message: string,
    readonly reason: SecretProxyFailureReason,
    /** Set only when the run is valid and exactly these selections were refused. */
    readonly selections?: SecretProxySelection[]
  ) {
    super(message);
  }
}
export type PlaceholderKeyring = { activeKeyId: string; keys: Map<string, Buffer> };

export function parsePlaceholderKeyring(input: string): PlaceholderKeyring {
  const parsed = Keyring.parse(JSON.parse(input));
  const keys = Object.entries(parsed.keys);
  if (!Object.hasOwn(parsed.keys, parsed.activeKeyId) || keys.length > MAX_RETAINED_KEYS) {
    throw new Error("Invalid secret proxy placeholder keyring");
  }
  return {
    activeKeyId: parsed.activeKeyId,
    keys: new Map(keys.map(([id, key]) => [id, Buffer.from(key, "hex")])),
  };
}

export function configuredPlaceholderKeyring(enabled: boolean, input?: string) {
  return enabled && input ? parsePlaceholderKeyring(input) : undefined;
}

export function placeholderForVariable(
  keyring: PlaceholderKeyring,
  identity: { runId: string; attempt: number },
  variableId: string,
  keyId = keyring.activeKeyId
): string {
  const key = keyring.keys.get(keyId);
  if (!key || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1) {
    throw new Error("Invalid secret proxy placeholder identity");
  }
  const digest = createHmac("sha256", key)
    .update(JSON.stringify(["proxy-placeholder-v1", identity.runId, identity.attempt, variableId]))
    .digest("hex");
  return `trsec_v1_${keyId}_${digest}`;
}

export function serviceTokenMatches(supplied: string | null, expected: string | undefined) {
  if (!supplied || !expected) return false;
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function isCanonicalProxyHostname(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    !isIP(hostname) &&
    hostname.includes(".") &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

export function secretProxyExecutionHosts(values: EffectiveEnvironmentVariable[]) {
  const destinations = new Set<string>();
  for (const value of values) {
    const hosts = ProxyAllowedHosts.safeParse(value.proxyAllowedHosts);
    if (!hosts.success)
      throw new SecretProxyDeniedError("Invalid proxy-only destination policy", "policy");
    hosts.data.forEach((host) => destinations.add(host));
  }
  if (destinations.size > MAX_EXECUTION_HOSTS)
    throw new SecretProxyDeniedError(
      "Too many secret proxy destinations for an execution",
      "limit"
    );
  return [...destinations];
}

const ProxyAllowedHosts = z
  .array(z.string().refine(isCanonicalProxyHostname))
  .min(1)
  .max(64)
  .refine((hosts) => new Set(hosts).size === hosts.length);

// Stored as JSONB so later policy (for example paths) can be added. Strict: an unknown field may be
// a restriction this version cannot enforce, so it must deny rather than be ignored.
const ProxyConfig = z.object({ allowedHosts: ProxyAllowedHosts }).strict();

/** Allowed hosts of a stored proxy-only value. Invalid config yields none, which denies. */
export function proxyConfigHosts(config: unknown): string[] {
  const parsed = ProxyConfig.safeParse(config);
  return parsed.success ? parsed.data.allowedHosts : [];
}
