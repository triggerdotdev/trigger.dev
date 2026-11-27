import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { JWT_AUDIENCE, JWT_ISSUER, WorkloadDeploymentTokenClaims } from "@trigger.dev/core/v3";
import { parseRunId } from "@trigger.dev/core/v3/isomorphic";
import { LRUCache } from "lru-cache";
import { z } from "zod";

const WORKER_ACTION_TOKEN_ACTIONS = [
  "start",
  "start_version",
  "complete",
  "continue",
  "heartbeat",
  "suspend",
  "snapshots_latest",
  "snapshots_since",
  "restore_outcome",
  "release",
] as const;

export type WorkerActionTokenAction = (typeof WORKER_ACTION_TOKEN_ACTIONS)[number];

export type WorkerActionTokenRouteAction = Exclude<WorkerActionTokenAction, "start_version">;

const WORKER_ACTION_TOKEN_MODE_VALUES = ["off", "log", "enforce"] as const;

export type WorkerActionTokenMode = (typeof WORKER_ACTION_TOKEN_MODE_VALUES)[number];

export type WorkerActionTokenModes = Record<WorkerActionTokenAction, WorkerActionTokenMode>;

function isAction(value: string): value is WorkerActionTokenAction {
  return (WORKER_ACTION_TOKEN_ACTIONS as readonly string[]).includes(value);
}

function isMode(value: string): value is WorkerActionTokenMode {
  return (WORKER_ACTION_TOKEN_MODE_VALUES as readonly string[]).includes(value);
}

export function parseWorkerActionTokenModes(raw: string | undefined): WorkerActionTokenModes {
  const explicit = new Map<string, WorkerActionTokenMode>();

  if (raw && raw.trim() !== "") {
    for (const part of raw.split(",")) {
      const entry = part.trim();
      if (entry === "") continue;

      const separator = entry.indexOf("=");
      if (separator === -1) {
        throw new Error(`WORKER_ACTION_TOKEN_MODES entry "${entry}" must be key=mode`);
      }

      const key = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();

      if (key !== "default" && !isAction(key)) {
        throw new Error(`WORKER_ACTION_TOKEN_MODES has an unknown action "${key}"`);
      }
      if (!isMode(value)) {
        throw new Error(`WORKER_ACTION_TOKEN_MODES has an unknown mode "${value}" for "${key}"`);
      }
      if (explicit.has(key)) {
        throw new Error(`WORKER_ACTION_TOKEN_MODES sets "${key}" more than once`);
      }

      explicit.set(key, value);
    }
  }

  const fallback = explicit.get("default") ?? "off";
  const modes = {} as WorkerActionTokenModes;
  for (const action of WORKER_ACTION_TOKEN_ACTIONS) {
    modes[action] = explicit.get(action) ?? fallback;
  }
  return modes;
}

const PUBLIC_KEY_PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";

const WorkloadTokenPublicKeyEntry = z
  .object({
    publicKey: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.startsWith(PUBLIC_KEY_PEM_BEGIN), {
        message: `publicKey must start with ${PUBLIC_KEY_PEM_BEGIN}`,
      }),
    runCutoff: z.string().datetime().optional(),
  })
  .strict();

export type WorkloadTokenPublicKey = z.infer<typeof WorkloadTokenPublicKeyEntry>;

function parseWorkloadTokenPublicKeys(raw: string | undefined): WorkloadTokenPublicKey[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("WORKLOAD_TOKEN_PUBLIC_KEYS must be valid JSON");
  }

  const parsed = z.array(WorkloadTokenPublicKeyEntry).safeParse(json);
  if (!parsed.success) {
    throw new Error(`WORKLOAD_TOKEN_PUBLIC_KEYS is invalid: ${parsed.error.message}`);
  }

  for (const entry of parsed.data) {
    if (createPublicKey(entry.publicKey).asymmetricKeyType !== "ed25519") {
      throw new Error("WORKLOAD_TOKEN_PUBLIC_KEYS entries must be Ed25519 public keys");
    }
  }

  return parsed.data;
}

export type WorkerActionTokenConfig = {
  modes: WorkerActionTokenModes;
  publicKeys: WorkloadTokenPublicKey[];
  cutoffMs?: number;
};

export function parseWorkerActionTokenConfig(raw: {
  modes: string | undefined;
  publicKeys: string | undefined;
  cutoff: string | undefined;
}): WorkerActionTokenConfig {
  const modes = parseWorkerActionTokenModes(raw.modes);
  const publicKeys = parseWorkloadTokenPublicKeys(raw.publicKeys);

  let cutoffMs: number | undefined;
  if (raw.cutoff && raw.cutoff.trim() !== "") {
    if (!z.string().datetime().safeParse(raw.cutoff.trim()).success) {
      throw new Error("WORKER_ACTION_TOKEN_CUTOFF must be an ISO 8601 datetime");
    }
    cutoffMs = Date.parse(raw.cutoff.trim());
  }

  const enforced = WORKER_ACTION_TOKEN_ACTIONS.filter((action) => modes[action] === "enforce");
  if (enforced.length > 0 && publicKeys.length === 0) {
    throw new Error("WORKER_ACTION_TOKEN_MODES enforce needs WORKLOAD_TOKEN_PUBLIC_KEYS");
  }
  if (enforced.length > 0 && cutoffMs === undefined) {
    throw new Error("WORKER_ACTION_TOKEN_MODES enforce needs WORKER_ACTION_TOKEN_CUTOFF");
  }

  return { modes, publicKeys, cutoffMs };
}

export type VerifiedWorkerActionToken = {
  claims: WorkloadDeploymentTokenClaims;
  runCutoffMs?: number;
};

const ED25519_SIGNATURE_BYTES = 64;

function verifyEd25519Token(
  token: string,
  publicKey: KeyObject,
  nowMs: number
): WorkloadDeploymentTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return undefined;

  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof header !== "object" || header === null) return undefined;
  if ((header as { alg?: unknown }).alg !== "EdDSA") return undefined;

  const signature = Buffer.from(signatureB64, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) return undefined;

  let signatureValid: boolean;
  try {
    signatureValid = verify(null, Buffer.from(`${headerB64}.${payloadB64}`), publicKey, signature);
  } catch {
    return undefined;
  }
  if (!signatureValid) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const { exp, iss, aud } = payload as { exp?: unknown; iss?: unknown; aud?: unknown };
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return undefined;
  if (iss !== JWT_ISSUER) return undefined;
  if (!(Array.isArray(aud) ? aud.includes(JWT_AUDIENCE) : aud === JWT_AUDIENCE)) return undefined;

  const parsed = WorkloadDeploymentTokenClaims.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

export type WorkerActionTokenVerifier = {
  verify(token: string): VerifiedWorkerActionToken | undefined;
};

export function createWorkerActionTokenVerifier(
  publicKeys: WorkloadTokenPublicKey[],
  options: { cacheSize?: number; now?: () => number } = {}
): WorkerActionTokenVerifier {
  const now = options.now ?? Date.now;
  const keys = [
    ...publicKeys.filter((entry) => !entry.runCutoff),
    ...publicKeys.filter((entry) => entry.runCutoff),
  ].map((entry) => {
    const publicKey = createPublicKey(entry.publicKey);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("WORKLOAD_TOKEN_PUBLIC_KEYS entries must be Ed25519 public keys");
    }
    return {
      publicKey,
      runCutoffMs: entry.runCutoff ? Date.parse(entry.runCutoff) : undefined,
    };
  });

  const cache = new LRUCache<string, VerifiedWorkerActionToken>({
    max: options.cacheSize ?? 10_000,
  });

  return {
    verify(token) {
      const nowMs = now();
      const cacheKey = createHash("sha256").update(token).digest("hex");

      const cached = cache.get(cacheKey);
      if (cached) {
        if (cached.claims.exp * 1000 > nowMs) return cached;
        cache.delete(cacheKey);
        return undefined;
      }

      for (const key of keys) {
        const claims = verifyEd25519Token(token, key.publicKey, nowMs);
        if (claims) {
          const verified = { claims, runCutoffMs: key.runCutoffMs };
          cache.set(cacheKey, verified);
          return verified;
        }
      }

      return undefined;
    },
  };
}

type WorkerActionTokenOutcome =
  | "verified"
  | "global_exempt"
  | "grandfathered"
  | "denied"
  | "run_mismatch"
  | "env_mismatch";

export type CreatedAfterCutoff = "true" | "false" | "unknown";

export type WorkerActionTokenEvaluation = {
  outcome: WorkerActionTokenOutcome;
  allowed: boolean;
  verified?: VerifiedWorkerActionToken;
  createdAfterCutoff: CreatedAfterCutoff;
};

export type WorkerActionTokenRuleInput = {
  mode: Exclude<WorkerActionTokenMode, "off">;
  token?: VerifiedWorkerActionToken;
  routeRunFriendlyId: string;
  headerEnvironmentId?: string;
  tokenKind: "global" | "previous-global" | "child";
  cutoffMs?: number;
  loadRunCreatedAt: () => Promise<Date | undefined>;
};

function runCreatedAtFromRunId(runFriendlyId: string): Date | undefined {
  if (!runFriendlyId.startsWith("run_")) return undefined;
  const parsed = parseRunId(runFriendlyId);
  return parsed.format === "legacy" ? undefined : parsed.timestamp;
}

export async function evaluateWorkerActionToken(
  input: WorkerActionTokenRuleInput
): Promise<WorkerActionTokenEvaluation> {
  let createdAt = runCreatedAtFromRunId(input.routeRunFriendlyId);
  let createdAtLoaded = createdAt !== undefined;
  const loadRunCreatedAt = async () => {
    if (!createdAtLoaded) {
      createdAt = await input.loadRunCreatedAt();
      createdAtLoaded = true;
    }
    return createdAt;
  };
  const previousKeyAllowsRun = async (runCutoffMs: number) => {
    const runCreatedAt = await loadRunCreatedAt();
    return runCreatedAt !== undefined && runCreatedAt.getTime() < runCutoffMs;
  };
  const createdAfterCutoff = (): CreatedAfterCutoff =>
    createdAt === undefined || input.cutoffMs === undefined
      ? "unknown"
      : createdAt.getTime() > input.cutoffMs
        ? "true"
        : "false";

  let token = input.token;

  if (token?.claims.run !== undefined && token.claims.run !== input.routeRunFriendlyId) {
    return { outcome: "run_mismatch", allowed: false, createdAfterCutoff: createdAfterCutoff() };
  }

  if (token?.runCutoffMs !== undefined && !(await previousKeyAllowsRun(token.runCutoffMs))) {
    token = undefined;
  }

  if (token) {
    const envMismatch =
      input.mode === "log" &&
      input.headerEnvironmentId !== undefined &&
      input.headerEnvironmentId !== token.claims.environment_id;

    return {
      outcome: envMismatch ? "env_mismatch" : "verified",
      allowed: true,
      verified: token,
      createdAfterCutoff: createdAfterCutoff(),
    };
  }

  if (input.tokenKind === "global") {
    return { outcome: "global_exempt", allowed: true, createdAfterCutoff: createdAfterCutoff() };
  }

  if (input.cutoffMs !== undefined) {
    const runCreatedAt = await loadRunCreatedAt();
    if (runCreatedAt !== undefined && runCreatedAt.getTime() <= input.cutoffMs) {
      return { outcome: "grandfathered", allowed: true, createdAfterCutoff: "false" };
    }
  }

  return { outcome: "denied", allowed: false, createdAfterCutoff: createdAfterCutoff() };
}
