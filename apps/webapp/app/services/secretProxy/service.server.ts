import type { EnvVarGrant } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { z } from "zod";
import { recordSecretProxyDelivery, recordSecretProxyFailure } from "./telemetry.server";
import type { PublicJwks } from "../oidc/crypto";
import { verifyRunTokenWithExpiry, type RunTokenClaims } from "../oidc/runTokenVerify";
import type { EnvironmentEncryptionService } from "../environmentEncryption/service.server";
import { pinnedRunPolicy } from "~/v3/services/worker/runExecutionPolicy.server";
import {
  secretProxyExecutionHosts,
  isCanonicalProxyHostname,
  placeholderForVariable,
  SecretProxyDeniedError,
  type SecretProxySelection,
  SECRET_PROXY_MAX_CREDENTIAL_BYTES,
  SECRET_PROXY_MAX_RESPONSE_BYTES,
  serviceTokenMatches,
  type PlaceholderKeyring,
} from "./placeholder.server";
import {
  effectiveProxyValues,
  MAX_PROXY_VARIABLES,
  type EffectiveEnvironmentVariable,
} from "./variables.server";

const SECRET_PROXY_PLAINTEXT_CACHE_TTL_MS = 30_000;
export const SECRET_PROXY_MAX_REQUEST_BYTES = 32_768;
const MAX_RESOLVE_ITEMS = 64;
const ResolveSecretProxyRequest = z
  .object({
    bindingId: z.string().min(1).max(256),
    resolve: z
      .array(
        z
          .object({
            handle: z.string().regex(/^trsec_v1_[A-Za-z0-9-]{1,32}_[0-9a-f]{64}$/),
            hostname: z.string().refine(isCanonicalProxyHostname),
            port: z.literal(443),
          })
          .strict()
      )
      .max(MAX_RESOLVE_ITEMS),
  })
  .strict();

export { SecretProxyDeniedError } from "./placeholder.server";

export type SecretProxyExecutionMetadata = {
  runId: string;
  attempt: number;
  expiresAtMs: number;
  allowedHosts: string[];
};
type RunState = {
  friendlyId: string;
  runtimeEnvironmentId: string;
  projectId: string;
  organizationId: string | null;
  attemptNumber: number | null;
  status: string;
  annotations: unknown;
};

type StoredProxyVariable = {
  variableId: string;
  environmentId: string;
  parentEnvironmentId: string | null;
  isProxyOnly: boolean;
  proxyConfig: Prisma.JsonValue;
  secretKey: string;
  encryptedValue: Prisma.JsonValue;
  storeVersion: string | null;
};

type Options = {
  db: PrismaClientOrTransaction;
  encryption: EnvironmentEncryptionService;
  enabled: boolean;
  keyring?: PlaceholderKeyring;
  serviceToken?: string;
  issuer?: string;
  publicJwks: () => Promise<PublicJwks>;
  findRun: (
    id: string,
    environmentId: string,
    projectId: string
  ) => Promise<RunState | null | undefined>;
};

export class SecretProxyService {
  constructor(private readonly options: Options) {}

  serviceAuthenticated(token: string | null) {
    return serviceTokenMatches(token, this.options.serviceToken);
  }

  #assertConfigured() {
    if (
      !this.options.enabled ||
      !this.options.keyring ||
      !this.options.issuer ||
      !this.options.serviceToken
    ) {
      throw new SecretProxyDeniedError("Secret proxy is disabled", "disabled");
    }
  }

  async #claims(token: string): Promise<RunTokenClaims & { exp: number }> {
    this.#assertConfigured();
    const claims = await verifyRunTokenWithExpiry({
      token,
      jwks: await this.options.publicJwks(),
      issuer: this.options.issuer!,
    });
    if (!claims || claims.attempt < 1 || claims.exp * 1000 <= Date.now())
      throw new SecretProxyDeniedError("Invalid run token", "token");
    return claims;
  }

  /** Returns the variables the run may resolve: its pinned grant, or all for a standard run. */
  async #assertExecuting(claims: RunTokenClaims): Promise<EnvVarGrant> {
    let id: string;
    try {
      id = RunId.fromFriendlyId(claims.run_id);
    } catch {
      throw new SecretProxyDeniedError("Invalid run identity", "run_state");
    }
    const run = await this.options.findRun(id, claims.environment_id, claims.project_id);
    // Non-checkpointing waits retain EXECUTING here; checkpoints set WAITING_TO_RESUME.
    if (
      !run ||
      run.friendlyId !== claims.run_id ||
      run.runtimeEnvironmentId !== claims.environment_id ||
      run.projectId !== claims.project_id ||
      run.organizationId !== claims.org_id ||
      run.attemptNumber !== claims.attempt ||
      run.status !== "EXECUTING"
    ) {
      throw new SecretProxyDeniedError("Run attempt is not executing", "run_state");
    }
    try {
      return pinnedRunPolicy(run.annotations)?.policy.envVars ?? "all";
    } catch {
      throw new SecretProxyDeniedError("Invalid run execution policy", "policy");
    }
  }

  async preflightRuntime(
    projectId: string,
    environmentId: string,
    values: EffectiveEnvironmentVariable[],
    runTokenAvailable: boolean,
    supportsSecretProxy: boolean
  ) {
    try {
      if (!values.some((value) => value.isProxyOnly)) return [];
      this.#assertConfigured();
      if (!supportsSecretProxy)
        throw new SecretProxyDeniedError(
          "Worker does not support secret proxy delivery",
          "capability"
        );
      if (!runTokenAvailable)
        throw new SecretProxyDeniedError(
          "Proxy-only variables require a supported run token",
          "token"
        );
      const hosts = secretProxyExecutionHosts(values.filter((value) => value.isProxyOnly));
      const environment = await this.options.db.runtimeEnvironment.findFirst({
        where: {
          id: environmentId,
          projectId,
          archivedAt: null,
          type: { not: "DEVELOPMENT" },
          project: { deletedAt: null },
        },
        select: { id: true },
      });
      if (!environment)
        throw new SecretProxyDeniedError("Unsupported runtime environment", "environment");
      recordSecretProxyDelivery("preflight", this.options.enabled, "protected");
      return hosts;
    } catch (error) {
      const denied = error instanceof SecretProxyDeniedError;
      recordSecretProxyDelivery("preflight", this.options.enabled, denied ? "denied" : "error");
      recordSecretProxyFailure("preflight", denied ? error.reason : "dependency");
      throw error;
    }
  }

  finalizeRuntime(
    values: EffectiveEnvironmentVariable[],
    allowedHosts: string[],
    execution: { runId: string; attempt: number; expiresAtMs: number }
  ) {
    return {
      placeholders: values.map((value) => ({
        key: value.key,
        value: placeholderForVariable(this.options.keyring!, execution, value.variableId),
      })),
      secretProxy: { ...execution, allowedHosts },
    };
  }

  async resolve(serviceToken: string | null, token: string, input: unknown) {
    const startedAt = Date.now();
    if (!this.serviceAuthenticated(serviceToken))
      throw new SecretProxyDeniedError("Invalid service credential", "service_auth");
    const request = ResolveSecretProxyRequest.parse(input);
    const claims = await this.#claims(token);
    const expiresAtMs = Math.min(
      startedAt + SECRET_PROXY_PLAINTEXT_CACHE_TTL_MS,
      claims.exp * 1000
    );
    const grant = await this.#assertExecuting(claims);
    const from = Prisma.sql`
      FROM "RuntimeEnvironment" e
      JOIN "Project" p ON p.id = e."projectId" AND p."deletedAt" IS NULL
      JOIN LATERAL (VALUES (e.id), (e."parentEnvironmentId")) source(id) ON source.id IS NOT NULL
      JOIN "RuntimeEnvironment" owner ON owner.id = source.id AND owner."projectId" = e."projectId"
      JOIN "EnvironmentVariableValue" value ON value."environmentId" = source.id
      JOIN "EnvironmentVariable" variable ON variable.id = value."variableId" AND variable."projectId" = e."projectId"
    `;
    const scope = Prisma.sql`
      WHERE e.id = ${claims.environment_id}
        AND e."projectId" = ${claims.project_id}
        AND e."organizationId" = ${claims.org_id}
        AND e."archivedAt" IS NULL AND e.type <> 'DEVELOPMENT'
    `;
    // Identity lookup only. Authorization below uses the policy joined to the exact ciphertext.
    const identities = await this.options.db.$queryRaw<Array<{ variableId: string }>>(Prisma.sql`
      SELECT DISTINCT value."variableId"
      ${from} ${scope} AND value."isProxyOnly" = true
      ${grant === "all" ? Prisma.empty : Prisma.sql`AND variable.key = ANY(${grant}::text[])`}
      LIMIT ${MAX_PROXY_VARIABLES + 1}
    `);
    if (identities.length > MAX_PROXY_VARIABLES)
      throw new SecretProxyDeniedError("Too many secret proxy variables", "limit");
    // The run is verified above, so refusals below depend only on the (handle, hostname) pair.
    // They name every refused selection so the relay can deny just those and keep the run's
    // other grants: a warm VM can carry a leftover process still using a previous run's handles.
    const mappings = new Map<string, Map<string, string>>();
    const unknown: SecretProxySelection[] = [];
    const selected = request.resolve.flatMap((item) => {
      const [, , keyId] = item.handle.split("_");
      if (!keyId || !this.options.keyring!.keys.has(keyId)) {
        unknown.push({ handle: item.handle, hostname: item.hostname });
        return [];
      }
      let byHandle = mappings.get(keyId);
      if (!byHandle) {
        byHandle = new Map(
          identities.map(({ variableId }) => [
            placeholderForVariable(
              this.options.keyring!,
              { runId: claims.run_id, attempt: claims.attempt },
              variableId,
              keyId
            ),
            variableId,
          ])
        );
        mappings.set(keyId, byHandle);
      }
      const variableId = byHandle.get(item.handle);
      if (!variableId) {
        unknown.push({ handle: item.handle, hostname: item.hostname });
        return [];
      }
      return [{ handle: item.handle, hostname: item.hostname, variableId }];
    });
    if (unknown.length)
      throw new SecretProxyDeniedError(
        "Handle or destination is not authorized",
        "placeholder",
        unknown
      );
    const ids = [...new Set(selected.map((item) => item.variableId))];
    const secretKey = Prisma.sql`concat('environmentvariable:', variable."projectId", ':', value."environmentId", ':', variable.key)`;
    const rows = ids.length
      ? await this.options.db.$queryRaw<StoredProxyVariable[]>(Prisma.sql`
          SELECT value."variableId", value."environmentId", e."parentEnvironmentId",
                 value."isProxyOnly", value."proxyConfig",
                 ${secretKey} AS "secretKey", s.value AS "encryptedValue", s.version AS "storeVersion"
          ${from}
          LEFT JOIN "SecretStore" s ON s.key = ${secretKey}
          ${scope} AND value."variableId" = ANY(${ids}::text[])
        `)
      : [];
    const values = new Map(
      effectiveProxyValues(rows, claims.environment_id, rows[0]?.parentEnvironmentId).map(
        (value) => [value.variableId, value]
      )
    );
    const disallowed = selected
      .filter((item) => {
        const value = values.get(item.variableId);
        return !value?.isProxyOnly || !value.proxyAllowedHosts.includes(item.hostname);
      })
      .map(({ handle, hostname }) => ({ handle, hostname }));
    if (disallowed.length)
      throw new SecretProxyDeniedError(
        "Handle or destination is not authorized",
        "policy",
        disallowed
      );
    const items = ids.map((id) => {
      const value = values.get(id)!;
      if (value.storeVersion === null)
        throw new SecretProxyDeniedError("Secret is unavailable", "secret_unavailable");
      return {
        projectId: claims.project_id,
        context: {
          environmentId: value.environmentId,
          purpose: "environment-variable" as const,
          objectId: value.secretKey,
        },
        value: value.encryptedValue,
        version: value.storeVersion,
      };
    });
    const decrypted = await this.options.encryption.decryptMany(items, this.options.db);
    const plaintext = new Map(
      items.map((item, i) => [
        item.context.objectId,
        z.object({ secret: z.string() }).parse(JSON.parse(decrypted[i]!)).secret,
      ])
    );
    let credentialBytes = 0;
    const credentials = selected.map(({ handle, hostname, variableId }) => {
      const value = plaintext.get(values.get(variableId)!.secretKey)!;
      credentialBytes += Buffer.byteLength(value);
      if (credentialBytes > SECRET_PROXY_MAX_CREDENTIAL_BYTES)
        throw new SecretProxyDeniedError("Secret proxy credentials too large", "limit");
      return { handle, hostname, value };
    });
    await this.#assertExecuting(claims);
    if (expiresAtMs <= Date.now())
      throw new SecretProxyDeniedError("Authorization expired", "expired");
    const response = { runId: claims.run_id, attempt: claims.attempt, expiresAtMs, credentials };
    if (Buffer.byteLength(JSON.stringify(response)) > SECRET_PROXY_MAX_RESPONSE_BYTES)
      throw new SecretProxyDeniedError("Secret proxy response payload budget exceeded", "limit");
    return response;
  }
}
