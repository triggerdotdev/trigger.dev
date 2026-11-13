import { randomBytes } from "node:crypto";
import cuid from "cuid";
import {
  boundedIn,
  type EnvironmentEncryptionKey,
  type EnvironmentEncryptionPolicy,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import { LRUCache } from "lru-cache";
import { environmentEncryptionTelemetry } from "./telemetry.server";
import { FEATURE_FLAG, isPlainFlagObject } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import {
  decryptValue,
  encryptValue,
  type EncryptionKeyring,
} from "~/utils/encryptionKeyring.server";
import {
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  parseStoredEnvironmentValue,
  type ObjectContext,
  type StoredEnvironmentValue,
} from "./crypto.server";
import {
  EnvironmentKeyUnavailableError,
  EnvironmentKeyWrapper,
  type WrappingPolicy,
} from "./wrapping.server";

type RunTransaction = <T>(
  fn: (tx: PrismaTransactionClient) => Promise<T>
) => Promise<T | undefined>;
type Scope = { projectId: string; environmentId: string };
type PolicyEntry = { projectId: string; policy: EnvironmentEncryptionPolicy | null };
export type PreparedEnvironmentWrite = Scope & {
  revision: number;
  keyId: string | null;
  key?: Buffer;
};
const POLICY_TTL_MS = 30_000;
const CACHE_ENTRIES = 30_000;
const INITIALIZATION_ATTEMPTS = 3;

class EncryptionPolicyChangedError extends Error {
  constructor() {
    super("Environment encryption policy changed; retry the operation");
  }
}

export class EnvironmentEncryptionService {
  readonly #policies = new LRUCache<string, PolicyEntry>({
    max: CACHE_ENTRIES,
    ttl: POLICY_TTL_MS,
  });
  readonly #keys = new LRUCache<string, Buffer>({ max: CACHE_ENTRIES });
  readonly #unwrapping = new Map<string, Promise<Buffer>>();
  readonly #registryLoads = new Map<string, Promise<EnvironmentEncryptionKey | undefined>>();
  readonly #failures = new LRUCache<string, Error>({ max: CACHE_ENTRIES, ttl: 1_000 });
  readonly #initializing = new Map<string, Promise<PreparedEnvironmentWrite>>();
  readonly #wrapper: EnvironmentKeyWrapper;

  constructor(
    private readonly options: {
      db: PrismaClientOrTransaction;
      transaction: RunTransaction;
      keyring: EncryptionKeyring;
      writesEnabled: boolean;
      defaultWrappingPolicy: WrappingPolicy;
      onUnwrap?: () => void;
    }
  ) {
    this.#wrapper = new EnvironmentKeyWrapper(options.keyring);
  }

  #invalidatePolicy(environmentId: string) {
    this.#policies.delete(environmentId);
  }

  async policies(
    scopes: Scope[],
    fresh = false,
    readDb = this.options.db
  ): Promise<Map<string, PolicyEntry>> {
    const result = new Map<string, PolicyEntry>();
    const missing = new Map<string, Scope>();
    for (const scope of scopes) {
      const cached = !fresh && this.#policies.get(scope.environmentId);
      if (cached) {
        if (cached.projectId !== scope.projectId)
          throw new Error("Environment does not belong to project");
        result.set(scope.environmentId, cached);
      } else {
        const previous = missing.get(scope.environmentId);
        if (previous && previous.projectId !== scope.projectId)
          throw new Error("Conflicting environment ownership");
        missing.set(scope.environmentId, scope);
      }
    }
    if (missing.size) {
      const rows = await (fresh ? this.options.db : readDb).runtimeEnvironment.findMany({
        where: { id: { in: boundedIn([...missing.keys()]) } },
        select: { id: true, projectId: true, encryptionPolicy: true },
      });
      for (const row of rows) {
        if (row.projectId !== missing.get(row.id)?.projectId)
          throw new Error("Environment does not belong to project");
        const entry = { projectId: row.projectId, policy: row.encryptionPolicy };
        result.set(row.id, entry);
        this.#policies.set(row.id, entry);
      }
      if (rows.length !== missing.size) throw new Error("Environment not found");
    }
    return result;
  }

  #cacheKey(environmentId: string, keyId: string) {
    return JSON.stringify([environmentId, keyId]);
  }

  async #loadKeys(scopes: Array<Scope & { keyId: string }>, db = this.options.db) {
    const result = new Map<string, Buffer>();
    const missing = new Map<string, Scope & { keyId: string }>();
    for (const scope of scopes) {
      const id = this.#cacheKey(scope.environmentId, scope.keyId);
      const key = this.#keys.get(id);
      if (key) result.set(id, key);
      else {
        const failure = this.#failures.get(id);
        if (failure) throw failure;
        missing.set(id, scope);
      }
    }
    if (scopes.length) {
      const { cacheLookups } = environmentEncryptionTelemetry();
      cacheLookups.add(result.size, { outcome: "hit" });
      cacheLookups.add(missing.size, { outcome: "miss" });
    }
    if (missing.size) {
      const unloaded = [...new Set([...missing.values()].map((scope) => scope.keyId))].filter(
        (id) => !this.#registryLoads.has(id)
      );
      if (unloaded.length) {
        const batch = (async () => {
          const rows = await db.environmentEncryptionKey.findMany({
            where: { id: { in: boundedIn(unloaded) } },
          });
          const records = new Map(rows.map((record) => [record.id, record]));
          const absent = unloaded.filter((id) => !records.has(id));
          if (absent.length && db !== this.options.db) {
            const fresh = await this.options.db.environmentEncryptionKey.findMany({
              where: { id: { in: boundedIn(absent) } },
            });
            for (const record of fresh) records.set(record.id, record);
          }
          return records;
        })();
        for (const keyId of unloaded)
          this.#registryLoads.set(
            keyId,
            batch
              .then((records) => records.get(keyId))
              .finally(() => this.#registryLoads.delete(keyId))
          );
      }
      const loads = new Map(
        [...missing.values()].map((scope) => [scope.keyId, this.#registryLoads.get(scope.keyId)!])
      );
      await Promise.all(
        [...missing].map(async ([id, scope]) => {
          const record = await loads.get(scope.keyId);
          if (!record) throw new EnvironmentKeyUnavailableError();
          if (record.environmentId !== scope.environmentId)
            throw new Error("Encryption key ownership mismatch");
          const cached = this.#keys.get(id);
          if (cached) {
            result.set(id, cached);
            return;
          }
          let pending = this.#unwrapping.get(id);
          if (!pending) {
            pending = this.#wrapper
              .unwrap(record, record.environmentId, record.id, record.wrappedKey)
              .then((key) => {
                this.#keys.set(id, key);
                this.options.onUnwrap?.();
                return key;
              })
              .catch((error) => {
                this.options.onUnwrap?.();
                if (error instanceof Error) this.#failures.set(id, error);
                throw error;
              })
              .finally(() => this.#unwrapping.delete(id));
            this.#unwrapping.set(id, pending);
          }
          result.set(id, await pending);
        })
      );
    }
    return result;
  }

  async decryptMany(
    items: Array<{ projectId: string; context: ObjectContext; value: unknown; version?: string }>,
    readDb = this.options.db
  ): Promise<string[]> {
    if (!items.length) return [];
    const values = items.map((item) => parseStoredEnvironmentValue(item.value, item.version));
    const needed = values.flatMap((value, i) =>
      value?.scheme
        ? [
            {
              projectId: items[i]!.projectId,
              environmentId: items[i]!.context.environmentId,
              keyId: value.keyId,
            },
          ]
        : []
    );
    const policies = await this.policies(needed, false, readDb);
    const newlyInitialized = needed.filter(
      (scope) => !policies.get(scope.environmentId)?.policy?.activeKeyId
    );
    if (newlyInitialized.length) {
      const refreshed = await this.policies(newlyInitialized, true);
      for (const [id, entry] of refreshed) policies.set(id, entry);
    }
    for (const scope of needed) {
      if (!policies.get(scope.environmentId)?.policy)
        throw new Error("Missing environment encryption policy");
    }
    const keys = await this.#loadKeys(needed, readDb);
    return values.map((value, i) => {
      const item = items[i]!;
      if (!value?.scheme)
        return value ? decryptValue(value, this.options.keyring) : JSON.stringify(item.value);
      const key = keys.get(this.#cacheKey(item.context.environmentId, value.keyId));
      if (!key) throw new EnvironmentKeyUnavailableError();
      return decryptEnvironmentValue(value, key, item.context);
    });
  }

  async #ensurePolicy(scope: Scope): Promise<EnvironmentEncryptionPolicy> {
    let policy = (await this.policies([scope], true)).get(scope.environmentId)!.policy;
    if (!policy) {
      await this.options.db.environmentEncryptionPolicy.createMany({
        data: [{ environmentId: scope.environmentId }],
        skipDuplicates: true,
      });
      policy = await this.options.db.environmentEncryptionPolicy.findFirstOrThrow({
        where: { environmentId: scope.environmentId },
      });
      this.#invalidatePolicy(scope.environmentId);
    }
    return policy;
  }

  async #enrollmentEnabled(scope: Scope): Promise<boolean> {
    if (!this.options.writesEnabled) return false;
    const project = await this.options.db.project.findFirstOrThrow({
      where: { id: scope.projectId },
      select: { organization: { select: { featureFlags: true } } },
    });
    return makeFlag(this.options.db)({
      key: FEATURE_FLAG.environmentEncryptionEnabled,
      defaultValue: false,
      overrides: isPlainFlagObject(project.organization.featureFlags)
        ? project.organization.featureFlags
        : undefined,
    });
  }

  // knownPolicy must come from a project-scoped environment read.
  async prepareWrite(
    scope: Scope,
    knownPolicy?: Pick<EnvironmentEncryptionPolicy, "activeKeyId" | "revision"> | null
  ): Promise<PreparedEnvironmentWrite> {
    const policy =
      knownPolicy === undefined
        ? (await this.policies([scope], true)).get(scope.environmentId)!.policy
        : knownPolicy;
    if (!policy?.activeKeyId && !(await this.#enrollmentEnabled(scope)))
      return { ...scope, revision: policy?.revision ?? 0, keyId: null };
    if (policy?.activeKeyId) {
      const keys = await this.#loadKeys([{ ...scope, keyId: policy.activeKeyId }]);
      return {
        ...scope,
        revision: policy.revision,
        keyId: policy.activeKeyId,
        key: keys.get(this.#cacheKey(scope.environmentId, policy.activeKeyId))!,
      };
    }
    await this.#ensurePolicy(scope);
    let pending = this.#initializing.get(scope.environmentId);
    if (!pending) {
      pending = this.#initialize(scope).finally(() =>
        this.#initializing.delete(scope.environmentId)
      );
      this.#initializing.set(scope.environmentId, pending);
    }
    const result = await pending;
    if (result.projectId !== scope.projectId)
      throw new Error("Environment does not belong to project");
    return result;
  }

  async #wrapVerified(policy: WrappingPolicy, environmentId: string, id: string, key: Buffer) {
    const wrapped = await this.#wrapper.wrap(policy, environmentId, id, key);
    const check = await this.#wrapper.unwrap(
      { ...policy, ...wrapped },
      environmentId,
      id,
      wrapped.wrappedKey
    );
    try {
      if (!check.equals(key)) throw new Error("Environment-key unwrap verification failed");
    } finally {
      check.fill(0);
    }
    return wrapped;
  }

  async #initialize(scope: Scope): Promise<PreparedEnvironmentWrite> {
    for (let attempt = 0; attempt < INITIALIZATION_ATTEMPTS; attempt++) {
      const current = (await this.policies([scope], true)).get(scope.environmentId)!.policy;
      if (current?.activeKeyId) return this.prepareWrite(scope);
      const wrapping = this.options.defaultWrappingPolicy;
      const id = cuid();
      const key = randomBytes(32);
      try {
        const wrapped = await this.#wrapVerified(wrapping, scope.environmentId, id, key);
        const installed = await this.options.transaction(async (tx) => {
          await lockEnvironment(tx, scope);
          const policy = await tx.environmentEncryptionPolicy.findFirst({
            where: { environmentId: scope.environmentId },
          });
          if ((policy?.revision ?? -1) !== (current?.revision ?? -1) || policy?.activeKeyId)
            return false;
          await tx.environmentEncryptionKey.create({
            data: {
              id,
              environmentId: scope.environmentId,
              ...policyFields(wrapping),
              ...wrapped,
            },
          });
          await tx.environmentEncryptionPolicy.update({
            where: { environmentId: scope.environmentId },
            data: { ...policyFields(wrapping), activeKeyId: id, revision: { increment: 1 } },
          });
          return true;
        });
        this.#invalidatePolicy(scope.environmentId);
        if (installed) return this.prepareWrite(scope);
      } finally {
        key.fill(0);
      }
    }
    throw new EncryptionPolicyChangedError();
  }

  encrypt(
    prepared: PreparedEnvironmentWrite,
    context: ObjectContext,
    plaintext: string
  ): StoredEnvironmentValue {
    if (context.environmentId !== prepared.environmentId)
      throw new Error("Encryption context ownership mismatch");
    if (!prepared.keyId) return encryptValue(plaintext, this.options.keyring);
    if (!prepared.key) throw new EnvironmentKeyUnavailableError();
    return encryptEnvironmentValue(plaintext, prepared.keyId, prepared.key, context);
  }

  async assertWrite(tx: PrismaTransactionClient, prepared: PreparedEnvironmentWrite[]) {
    const unique = new Map(
      prepared.filter((value) => value.keyId).map((value) => [value.environmentId, value])
    );
    for (const value of [...unique.values()].sort((a, b) =>
      a.environmentId.localeCompare(b.environmentId)
    )) {
      await lockEnvironment(tx, value, "SHARE");
      const current = await tx.environmentEncryptionPolicy.findFirst({
        where: { environmentId: value.environmentId },
      });
      if (
        (current?.revision ?? -1) !== value.revision ||
        (current?.activeKeyId ?? null) !== value.keyId
      ) {
        throw new EncryptionPolicyChangedError();
      }
    }
  }

  async rotate(scope: Scope, wrapping?: WrappingPolicy) {
    const current = await this.#ensurePolicy(scope);
    const target =
      wrapping ??
      (current.activeKeyId ? policyFields(current) : this.options.defaultWrappingPolicy);
    const id = cuid();
    const key = randomBytes(32);
    try {
      const wrapped = await this.#wrapVerified(target, scope.environmentId, id, key);
      const result = await this.options.transaction(async (tx) => {
        await lockEnvironment(tx, scope);
        const policy = await tx.environmentEncryptionPolicy.findFirst({
          where: { environmentId: scope.environmentId },
        });
        if (policy?.revision !== current.revision) throw new EncryptionPolicyChangedError();
        await tx.environmentEncryptionKey.create({
          data: { id, environmentId: scope.environmentId, ...policyFields(target), ...wrapped },
        });
        return tx.environmentEncryptionPolicy.update({
          where: { environmentId: scope.environmentId },
          data: {
            ...policyFields(target),
            activeKeyId: id,
            revision: { increment: 1 },
          },
        });
      });
      if (!result) throw new Error("Key rotation did not commit");
      return result;
    } finally {
      key.fill(0);
      this.#invalidatePolicy(scope.environmentId);
    }
  }
}

async function lockEnvironment(
  tx: PrismaTransactionClient,
  scope: Scope,
  mode: "SHARE" | "UPDATE" = "UPDATE"
) {
  const rows =
    mode === "SHARE"
      ? await tx.$queryRaw<
          Array<{ environmentId: string }>
        >`SELECT p."environmentId" FROM "EnvironmentEncryptionPolicy" p JOIN "RuntimeEnvironment" e ON e.id = p."environmentId" WHERE e.id = ${scope.environmentId} AND e."projectId" = ${scope.projectId} FOR SHARE OF p`
      : await tx.$queryRaw<
          Array<{ environmentId: string }>
        >`SELECT p."environmentId" FROM "EnvironmentEncryptionPolicy" p JOIN "RuntimeEnvironment" e ON e.id = p."environmentId" WHERE e.id = ${scope.environmentId} AND e."projectId" = ${scope.projectId} FOR UPDATE OF p`;
  if (!rows.length) throw new Error("Environment encryption policy not found");
}

function policyFields(
  policy: Pick<EnvironmentEncryptionPolicy, "wrappingProvider" | "wrappingKeyReference">
): WrappingPolicy {
  if (!policy.wrappingProvider || !policy.wrappingKeyReference)
    throw new Error("Environment wrapping policy is not initialized");
  return {
    wrappingProvider: policy.wrappingProvider,
    wrappingKeyReference: policy.wrappingKeyReference,
  };
}
