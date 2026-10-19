import {
  isPrismaKnownError,
  type Prisma,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import type { JWTPayload, KeyLike } from "jose";
import { z } from "zod";
import {
  OIDC_ACTIVE_KEY_CACHE_TTL_SECONDS,
  OIDC_ADMIN_RETIRED_KEY_LIMIT,
  OIDC_JWKS_SERVER_CACHE_TTL_SECONDS,
  OIDC_KEY_PROPAGATION_DELAY_SECONDS,
  OIDC_RETIRED_KEY_RETENTION_SECONDS,
} from "./constants";
import {
  generateRs256KeyPair,
  importRs256PrivateKey,
  parsePublicRs256Jwk,
  signRs256Jwt,
  type PublicJwks,
} from "./crypto";

const PrivateKeySecretSchema = z.object({
  privateKeyPkcs8: z.string(),
});

const summarySelect = {
  id: true,
  kid: true,
  status: true,
  readyAt: true,
  publicUntil: true,
  createdAt: true,
  generatedByUserId: true,
  activatedAt: true,
  activatedByUserId: true,
  retiredAt: true,
  retiredByUserId: true,
} satisfies Prisma.OidcSigningKeySelect;

export type OidcSigningKeySummary = Prisma.OidcSigningKeyGetPayload<{
  select: typeof summarySelect;
}>;

export type OidcSigningStatus = {
  activeKey: OidcSigningKeySummary | null;
  stagedKey: OidcSigningKeySummary | null;
  retiredKeys: OidcSigningKeySummary[];
};

export type OidcSigningKeyErrorCode =
  | "INVALID_ACTOR"
  | "STAGED_KEY_EXISTS"
  | "KEY_NOT_FOUND"
  | "KEY_NOT_STAGED"
  | "KEY_NOT_READY"
  | "NO_ACTIVE_KEY"
  | "OIDC_NOT_CONFIGURED"
  | "PRIVATE_KEY_NOT_FOUND";

export class OidcSigningKeyError extends Error {
  constructor(
    readonly code: OidcSigningKeyErrorCode,
    message: string,
    readonly readyAt?: Date
  ) {
    super(message);
    this.name = "OidcSigningKeyError";
  }
}

type SigningKeySecretStore = {
  getSecret<T>(schema: z.Schema<T>, key: string): Promise<T | undefined>;
  setSecret<T extends object>(key: string, value: T): Promise<void>;
  deleteSecret(key: string): Promise<void>;
};

type RunTransaction = <Result>(
  name: string,
  fn: (tx: PrismaTransactionClient) => Promise<Result>
) => Promise<Result>;

type ActiveSigningKey = { kid: string; privateKey: KeyLike };

export class OidcSigningKeyService {
  readonly #db: PrismaClientOrTransaction;
  readonly #issuer: string | undefined;
  readonly #secretStore: (db: PrismaClientOrTransaction) => SigningKeySecretStore;
  readonly #runTransaction: RunTransaction;
  readonly #now: () => Date;

  readonly #jwks: TtlCache<PublicJwks>;
  readonly #activeKey: TtlCache<ActiveSigningKey | null>;
  // Survives active-key cache expiry so the private key is only decrypted once per rotation.
  #lastActiveKey: ActiveSigningKey | undefined;

  constructor({
    db,
    issuer,
    secretStore,
    runTransaction,
    now = () => new Date(),
  }: {
    db: PrismaClientOrTransaction;
    issuer?: string;
    secretStore: (db: PrismaClientOrTransaction) => SigningKeySecretStore;
    runTransaction: RunTransaction;
    now?: () => Date;
  }) {
    this.#db = db;
    this.#issuer = issuer;
    this.#secretStore = secretStore;
    this.#runTransaction = runTransaction;
    this.#now = now;
    this.#jwks = new TtlCache(OIDC_JWKS_SERVER_CACHE_TTL_SECONDS, now);
    this.#activeKey = new TtlCache(OIDC_ACTIVE_KEY_CACHE_TTL_SECONDS, now);
  }

  async getSigningStatus(): Promise<OidcSigningStatus> {
    const [activeKey, stagedKey, retiredKeys] = await Promise.all([
      this.#db.oidcSigningKey.findFirst({ where: { status: "ACTIVE" }, select: summarySelect }),
      this.#db.oidcSigningKey.findFirst({ where: { status: "STAGED" }, select: summarySelect }),
      this.#db.oidcSigningKey.findMany({
        where: { status: "RETIRED" },
        orderBy: { createdAt: "desc" },
        take: OIDC_ADMIN_RETIRED_KEY_LIMIT,
        select: summarySelect,
      }),
    ]);

    return { activeKey, stagedKey, retiredKeys };
  }

  getPublicJwks(): Promise<PublicJwks> {
    return this.#jwks.get(() => this.#loadPublicJwks());
  }

  async generateStagedKey(actorUserId: string): Promise<OidcSigningKeySummary> {
    assertActorUserId(actorUserId);
    const generated = await generateRs256KeyPair();
    const now = this.#now();

    try {
      const key = await this.#runTransaction("generate OIDC signing key", async (tx) => {
        await this.#secretStore(tx).setSecret(privateKeySecretKey(generated.kid), {
          privateKeyPkcs8: generated.privateKeyPkcs8,
        });

        return tx.oidcSigningKey.create({
          data: {
            kid: generated.kid,
            status: "STAGED",
            publicJwk: generated.publicJwk,
            readyAt: addSeconds(now, OIDC_KEY_PROPAGATION_DELAY_SECONDS),
            generatedByUserId: actorUserId,
          },
          select: summarySelect,
        });
      });
      this.#jwks.invalidate();
      return key;
    } catch (error) {
      // The only unique constraints are the random kid and the one-STAGED-key partial index.
      if (isPrismaKnownError(error) && error.code === "P2002") {
        throw new OidcSigningKeyError(
          "STAGED_KEY_EXISTS",
          "A staged OIDC signing key already exists"
        );
      }
      throw error;
    }
  }

  async activateKey(keyId: string, actorUserId: string): Promise<OidcSigningKeySummary> {
    assertActorUserId(actorUserId);
    const now = this.#now();

    const activated = await this.#runTransaction("activate OIDC signing key", async (tx) => {
      const candidate = await tx.oidcSigningKey.findFirst({
        where: { id: keyId },
        select: { status: true, readyAt: true },
      });
      if (!candidate) {
        throw new OidcSigningKeyError("KEY_NOT_FOUND", "OIDC signing key not found");
      }
      if (candidate.status !== "STAGED") {
        throw new OidcSigningKeyError("KEY_NOT_STAGED", "OIDC signing key is not staged");
      }
      if (candidate.readyAt > now) {
        throw new OidcSigningKeyError(
          "KEY_NOT_READY",
          "OIDC signing key has not finished propagating",
          candidate.readyAt
        );
      }

      await this.#retireActiveKey(tx, actorUserId, now);

      try {
        return await tx.oidcSigningKey.update({
          where: { id: keyId, status: "STAGED" },
          data: { status: "ACTIVE", activatedAt: now, activatedByUserId: actorUserId },
          select: summarySelect,
        });
      } catch (error) {
        if (isPrismaKnownError(error) && error.code === "P2025") {
          throw new OidcSigningKeyError("KEY_NOT_STAGED", "OIDC signing key is not staged");
        }
        throw error;
      }
    });

    this.#invalidateCaches();
    return activated;
  }

  // Ponytail: this is graceful retirement only; compromised-key revocation needs a separate state and operation.
  async disableSigning(actorUserId: string): Promise<void> {
    assertActorUserId(actorUserId);
    const now = this.#now();

    await this.#runTransaction("disable OIDC signing", (tx) =>
      this.#retireActiveKey(tx, actorUserId, now)
    );

    this.#invalidateCaches();
  }

  async signJwt(
    payload: JWTPayload,
    {
      audience,
      subject,
      expiresInSeconds,
    }: { audience: string | string[]; subject: string; expiresInSeconds: number }
  ): Promise<string> {
    if (!this.#issuer) {
      throw new OidcSigningKeyError("OIDC_NOT_CONFIGURED", "OIDC issuer is not configured");
    }

    const activeKey = await this.#activeKey.get(() => this.#loadActiveKey());
    if (!activeKey) {
      throw new OidcSigningKeyError("NO_ACTIVE_KEY", "OIDC signing is disabled");
    }

    return signRs256Jwt({
      payload,
      privateKey: activeKey.privateKey,
      kid: activeKey.kid,
      issuer: this.#issuer,
      audience,
      subject,
      expiresInSeconds,
      now: this.#now(),
    });
  }

  async #retireActiveKey(tx: PrismaTransactionClient, actorUserId: string, now: Date) {
    const active = await tx.oidcSigningKey.findFirst({
      where: { status: "ACTIVE" },
      select: { id: true, kid: true },
    });
    if (!active) {
      return;
    }

    const retired = await tx.oidcSigningKey.updateMany({
      where: { id: active.id, status: "ACTIVE" },
      data: {
        status: "RETIRED",
        retiredAt: now,
        retiredByUserId: actorUserId,
        publicUntil: addSeconds(now, OIDC_RETIRED_KEY_RETENTION_SECONDS),
      },
    });
    // A retired key never signs again; only its public key stays published.
    if (retired.count === 1) {
      await this.#secretStore(tx).deleteSecret(privateKeySecretKey(active.kid));
    }
  }

  async #loadActiveKey(): Promise<ActiveSigningKey | null> {
    // A rotation can retire the key and delete its secret between our two reads, so re-read the
    // active row once before treating a missing secret as an error.
    for (let attempt = 0; ; attempt++) {
      const row = await this.#db.oidcSigningKey.findFirst({
        where: { status: "ACTIVE" },
        select: { kid: true },
      });
      if (!row) {
        this.#lastActiveKey = undefined;
        return null;
      }
      if (this.#lastActiveKey?.kid === row.kid) {
        return this.#lastActiveKey;
      }

      const secret = await this.#secretStore(this.#db).getSecret(
        PrivateKeySecretSchema,
        privateKeySecretKey(row.kid)
      );
      if (!secret) {
        if (attempt === 0) {
          continue;
        }
        throw new OidcSigningKeyError(
          "PRIVATE_KEY_NOT_FOUND",
          "Active OIDC signing key material was not found"
        );
      }

      this.#lastActiveKey = {
        kid: row.kid,
        privateKey: await importRs256PrivateKey(secret.privateKeyPkcs8),
      };
      return this.#lastActiveKey;
    }
  }

  async #loadPublicJwks(): Promise<PublicJwks> {
    const rows = await this.#db.oidcSigningKey.findMany({
      where: {
        OR: [
          { status: { in: ["STAGED", "ACTIVE"] } },
          { status: "RETIRED", publicUntil: { gt: this.#now() } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { publicJwk: true },
    });

    return { keys: rows.map((key) => parsePublicRs256Jwk(key.publicJwk)) };
  }

  #invalidateCaches() {
    this.#jwks.invalidate();
    this.#activeKey.invalidate();
  }
}

/** Caches one async value for a fixed TTL and shares a single in-flight load between callers. */
class TtlCache<T> {
  #entry: { expiresAt: number; value: T } | undefined;
  #pending: Promise<T> | undefined;
  // Bumped on invalidate so a load that started before it can't repopulate the cache.
  #generation = 0;

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => Date
  ) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.#entry && this.#entry.expiresAt > this.now().getTime()) {
      return this.#entry.value;
    }
    if (this.#pending) {
      return this.#pending;
    }

    const generation = this.#generation;
    const pending = load();
    this.#pending = pending;
    try {
      const value = await pending;
      if (generation === this.#generation) {
        this.#entry = { value, expiresAt: this.now().getTime() + this.ttlSeconds * 1000 };
      }
      return value;
    } finally {
      if (this.#pending === pending) {
        this.#pending = undefined;
      }
    }
  }

  invalidate() {
    this.#generation++;
    this.#entry = undefined;
    this.#pending = undefined;
  }
}

function privateKeySecretKey(kid: string) {
  return `oidc-signing-key:${kid}`;
}

function assertActorUserId(actorUserId: string) {
  if (!actorUserId) {
    throw new OidcSigningKeyError("INVALID_ACTOR", "An actor user ID is required");
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
