import { createHash } from "node:crypto";
import { PatchStrategy } from "@kubernetes/client-node";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { Counter } from "prom-client";
import type { K8sApi } from "../clients/kubernetes.js";
import { register } from "../metrics.js";
import { k8sCreateRefused, k8sErrorMessage, WorkloadNotCreatedError } from "./createErrors.js";

/** The key inside a deployment's token Secret. */
const TOKEN_KEY = "token";

type OwnerReference = { apiVersion: string; kind: string; name: string; uid: string };

type TokenSecretOwnerKind = "Runner" | "Pod";

/** The Secret a create wrote, by the uid and version that guard its delete. */
type WrittenTokenSecret = { name: string; uid: string; resourceVersion?: string };

/** The Secret an owner references; a reused one carries no uid, so it is never deleted. */
export type TokenSecret = { name: string; key: string; uid?: string; resourceVersion?: string };

export type TokenSecretHolder = { uid?: string; secretName?: string };

const adoptionFailuresTotal = new Counter({
  name: "supervisor_token_secret_adoption_failures_total",
  help: "Token Secrets left without an owner because the ownerReferences patch or rewrite failed, by owner kind",
  labelNames: ["owner"],
  registers: [register],
});

const cleanupFailuresTotal = new Counter({
  name: "supervisor_token_secret_cleanup_failures_total",
  help: "Token Secrets from a failed create whose delete failed other than with 404 or 409, by owner kind",
  labelNames: ["owner"],
  registers: [register],
});

const createUnclearTotal = new Counter({
  name: "supervisor_token_secret_create_unclear_total",
  help: "Token Secret creates that failed with an error that may have committed, leaving a Secret with no owner, by owner kind",
  labelNames: ["owner"],
  registers: [register],
});

function createRejected(err: unknown): boolean {
  return k8sCreateRefused(err) || statusCodeOf(err) === 409;
}

export type TokenSecretsOptions = {
  k8s: K8sApi;
  namespace: string;
  logger: SimpleStructuredLogger;
  logPrefix: string;
  owner: { apiVersion: string; kind: TokenSecretOwnerKind };
  settleMs: number;
  releaseUnstartedRuns: boolean;
  readHolder: (name: string) => Promise<TokenSecretHolder>;
};

export class TokenSecrets {
  constructor(private readonly opts: TokenSecretsOptions) {}

  async ensure(name: string, token: string): Promise<TokenSecret> {
    try {
      const created = await this.write(name, token);
      return { name, key: TOKEN_KEY, ...metadataOf(created) };
    } catch (err: unknown) {
      if (statusCodeOf(err) === 409) {
        return { name, key: TOKEN_KEY };
      }
      if (!createRejected(err)) {
        createUnclearTotal.inc({ owner: this.opts.owner.kind });
      }
      this.opts.logger.error(`${this.opts.logPrefix} Runner token secret failed`, {
        name,
        rawError: err,
      });
      if (this.opts.releaseUnstartedRuns && k8sCreateRefused(err)) {
        throw new WorkloadNotCreatedError(k8sErrorMessage(err), { cause: err });
      }
      throw err;
    }
  }

  /**
   * Makes the owner own the Secret, so the garbage collector takes it with the
   * owner. An object that never had an owner is not a dependent, so nothing can
   * collect the Secret before this lands. A Secret gone by then (a redelivery's reuse
   * raced an earlier delivery's settle) is written again, owned from the start.
   *
   * Never throws: an ownerless Secret holding one expiring token costs less than
   * failing a run that is about to start.
   */
  async adopt(name: string, owner: { name: string; uid: string }, token?: string) {
    const ownerReferences: OwnerReference[] = [
      {
        apiVersion: this.opts.owner.apiVersion,
        kind: this.opts.owner.kind,
        name: owner.name,
        uid: owner.uid,
      },
    ];
    try {
      try {
        await this.opts.k8s.objects.patch(
          {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name, namespace: this.opts.namespace, ownerReferences },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.StrategicMergePatch
        );
      } catch (err: unknown) {
        if (statusCodeOf(err) !== 404 || token === undefined) {
          throw err;
        }
        await this.write(name, token, ownerReferences);
      }
    } catch (err: unknown) {
      adoptionFailuresTotal.inc({ owner: this.opts.owner.kind });
      this.opts.logger.warn(`${this.opts.logPrefix} Token secret adoption failed`, {
        name,
        runner: owner.name,
        rawError: err,
      });
    }
  }

  /**
   * An owner holding the name and referencing the Secret adopts it: the create went
   * through after all, or another delivery of this attempt reused the digest-named
   * Secret. One referencing another Secret means nothing will use it, and it is deleted
   * under its uid. With no owner yet, or none readable, the same look is taken again
   * later: the create may still commit, or a delivery reusing the name may be about to,
   * and a delete now would strand that owner.
   */
  async settle(token: TokenSecret | undefined, ownerName: string, createError: unknown) {
    if (!token?.uid) {
      return;
    }
    const kept: WrittenTokenSecret = {
      name: token.name,
      uid: token.uid,
      resourceVersion: token.resourceVersion,
    };
    if ((await this.settleHeld(kept, ownerName, createRejected(createError))) === "settled") {
      return;
    }
    setTimeout(async () => {
      if ((await this.settleHeld(kept, ownerName)) === "none") {
        await this.delete(kept);
      }
    }, this.opts.settleMs).unref();
  }

  /** Settles the Secret by the owner under the name, if there is one and it can be read. */
  private async settleHeld(
    token: WrittenTokenSecret,
    ownerName: string,
    deleteMismatch = true
  ): Promise<"settled" | "none" | "unreadable"> {
    let holder: TokenSecretHolder;
    try {
      holder = await this.opts.readHolder(ownerName);
    } catch (err: unknown) {
      if (statusCodeOf(err) === 404) {
        return "none";
      }
      this.opts.logger.warn(
        `${this.opts.logPrefix} Token secret kept, ${this.opts.owner.kind} unreadable`,
        { name: token.name, runnerId: ownerName, rawError: err }
      );
      return "unreadable";
    }
    if (holder.uid && holder.secretName === token.name) {
      await this.adopt(token.name, { name: ownerName, uid: holder.uid });
      return "settled";
    }
    if (!deleteMismatch) {
      return "none";
    }
    await this.delete(token);
    return "settled";
  }

  /**
   * Deleted under its uid and the version it was created with, so a Secret that is no
   * longer the one this call wrote, or that an owner adopted meanwhile, is left alone.
   * No read: the supervisor has no get on Secrets.
   */
  private async delete(token: WrittenTokenSecret) {
    try {
      await this.opts.k8s.core.deleteNamespacedSecret({
        namespace: this.opts.namespace,
        name: token.name,
        body: { preconditions: { uid: token.uid, resourceVersion: token.resourceVersion } },
      });
    } catch (err: unknown) {
      const status = statusCodeOf(err);
      if (status === 404 || status === 409) {
        return;
      }
      cleanupFailuresTotal.inc({ owner: this.opts.owner.kind });
      this.opts.logger.warn(`${this.opts.logPrefix} Token secret cleanup failed`, {
        name: token.name,
        rawError: err,
      });
    }
  }

  private async write(name: string, token: string, ownerReferences?: OwnerReference[]) {
    return await this.opts.k8s.core.createNamespacedSecret({
      namespace: this.opts.namespace,
      body: {
        metadata: {
          name,
          namespace: this.opts.namespace,
          labels: {
            "app.kubernetes.io/part-of": "trigger-worker",
            "app.kubernetes.io/component": "runner-token",
          },
          ...(ownerReferences ? { ownerReferences } : {}),
        },
        type: "Opaque",
        immutable: true,
        stringData: { [TOKEN_KEY]: token },
      },
    });
  }
}

/**
 * The runner id is already a legal Runner name; it is lowercased anyway because an
 * invalid Secret name fails the create. The token's digest is in the name because
 * the Secret is immutable, so a rotated key or moved expiry lands as a new Secret.
 *
 * The runner id is mixed into the digest so a listing cannot show which runners
 * share a token. It does not stop checking a known token against a name (the id
 * is in the name); that would need a salt this process does not have.
 */
export function runnerTokenSecretName(runnerId: string, token: string, nonce?: string): string {
  const id = runnerId.toLowerCase();
  const digest = createHash("sha256")
    .update(nonce ? `${id}:${token}:${nonce}` : `${id}:${token}`)
    .digest("hex")
    .slice(0, 8);
  return `${id}-token-${digest}`;
}

/** API objects come back untyped: an absent uid skips adoption and guards no delete. */
export function metadataOf(object: unknown): { uid?: string; resourceVersion?: string } {
  const meta = (object as { metadata?: { uid?: unknown; resourceVersion?: unknown } } | null)
    ?.metadata;
  return {
    uid: typeof meta?.uid === "string" ? meta.uid : undefined,
    resourceVersion: typeof meta?.resourceVersion === "string" ? meta.resourceVersion : undefined,
  };
}

/** The client reports a status in several shapes depending on which layer raised it. */
export function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const candidate = err as { code?: unknown; statusCode?: unknown; body?: { code?: unknown } };
  for (const value of [candidate.code, candidate.statusCode, candidate.body?.code]) {
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}
