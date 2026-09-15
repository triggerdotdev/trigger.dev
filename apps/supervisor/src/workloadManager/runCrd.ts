import { createHash } from "node:crypto";
import { PatchStrategy } from "@kubernetes/client-node";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { EnvironmentType, MachinePreset } from "@trigger.dev/core/v3";
import { type K8sApi, createK8sApi } from "../clients/kubernetes.js";
import { getRunnerId } from "../util.js";
import type {
  WorkloadManager,
  WorkloadManagerCreateOptions,
  WorkloadManagerOptions,
} from "./types.js";

const GROUP = "compute.trigger.dev";
const VERSION = "v1alpha1";
const PLURAL = "runners";

/** The key inside a deployment's token Secret. */
const TOKEN_KEY = "token";

type OwnerReference = { apiVersion: string; kind: string; name: string; uid: string };

export type RunCrdWorkloadManagerOptions = WorkloadManagerOptions & {
  /** Passed in, not read from env, so the translation below is testable alone. */
  namespace: string;
};

/**
 * Creates a Runner and stops. The operator builds the pod, so that the uid,
 * node-selection and label reasoning lives in one place instead of three.
 *
 * A runner, not a run: it goes on to serve however many later runs warm start
 * hands it, so the run that caused it is only its bootstrap.
 */
export class RunCrdWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("run-crd-workload-provider");
  private readonly k8s: K8sApi;
  private readonly namespace: string;

  constructor(opts: RunCrdWorkloadManagerOptions) {
    this.k8s = createK8sApi();
    this.namespace = opts.namespace;
  }

  async create(opts: WorkloadManagerCreateOptions) {
    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    const token = await this.ensureRunnerToken(opts, runnerId);

    const body = runnerBodyFor(opts, { name: runnerId, namespace: this.namespace, token });

    this.logger.verbose("[RunCrdWorkloadManager] Creating runner", { runnerId, body });

    let created: unknown;
    try {
      created = await this.k8s.custom.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        body,
        // An unknown field is then a 422 naming it, not a silent prune.
        fieldValidation: "Strict",
      });
    } catch (err: unknown) {
      // No 409 case: the name carries the attempt, so an object in the way is a
      // terminal one held for the operator's TTL, not this create having worked.
      await this.releaseRunnerToken(token, err);
      this.logger.error("[RunCrdWorkloadManager] Create failed", { runnerId, rawError: err });
      throw err;
    }

    const runnerUid = uidOf(created);
    if (token && runnerUid) {
      await this.adoptRunnerToken(token.name, { name: runnerId, uid: runnerUid });
    }
  }

  /**
   * Hands the Secret to the runner, so the collector takes it when the runner
   * goes. Until this lands the Secret has no owner at all, and an object that
   * never had one is not a dependent, so nothing is deciding to collect it in
   * the meantime.
   *
   * Never throws: an ownerless Secret outlives its runner, which is worth less
   * than failing a run that is otherwise about to start. It holds one token,
   * for one runner, and that token expires.
   */
  private async adoptRunnerToken(name: string, runner: { name: string; uid: string }) {
    const ownerReferences: OwnerReference[] = [
      { apiVersion: `${GROUP}/${VERSION}`, kind: "Runner", name: runner.name, uid: runner.uid },
    ];

    try {
      await this.k8s.objects.patch(
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace: this.namespace, ownerReferences },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.StrategicMergePatch
      );
    } catch (err: unknown) {
      this.logger.warn("[RunCrdWorkloadManager] Token secret adoption failed", {
        name,
        runner: runner.name,
        rawError: err,
      });
    }
  }

  /**
   * Takes back the Secret a failed create left behind. No owner is ever going
   * to arrive for it, and the collector only takes objects that had one, so it
   * would otherwise sit there holding a live token for good.
   *
   * Only when the server said no. A throw carrying no status, or a 5xx, may be
   * a create that committed before its response was lost, and deleting then
   * takes the credential from a Runner that is about to start, turning a
   * transient failure into a terminal one. The Secret is kept in that case and
   * the log says so, an ownerless Secret holding a token that expires being the
   * cheaper of the two mistakes. Reading the Runner back to tell the cases
   * apart would need get on runners, which is a wider Role for a rarer path.
   *
   * Only when this call wrote it, too: a uid comes back from a create and not
   * from a 409.
   */
  private async releaseRunnerToken(
    token: { name: string; uid?: string } | undefined,
    err: unknown
  ) {
    if (!token?.uid) {
      return;
    }

    const status = statusCodeOf(err);
    if (status !== undefined && status >= 400 && status < 500) {
      await this.deleteRunnerToken(token.name, token.uid);
      return;
    }

    this.logger.warn("[RunCrdWorkloadManager] Token secret kept after an indeterminate create", {
      name: token.name,
      status,
    });
  }

  /**
   * Deletes on uid, so
   * a Secret that is no longer the object this call wrote is left to whatever
   * holds it now. A 409 is that precondition refusing, which is the answer.
   */
  private async deleteRunnerToken(name: string, uid: string) {
    try {
      await this.k8s.core.deleteNamespacedSecret({
        namespace: this.namespace,
        name,
        body: { preconditions: { uid } },
      });
    } catch (err: unknown) {
      const status = statusCodeOf(err);
      if (status === 404 || status === 409) {
        return;
      }
      this.logger.warn("[RunCrdWorkloadManager] Token secret cleanup failed", {
        name,
        rawError: err,
      });
    }
  }

  /**
   * Writes the runner's token to a Secret of its own and returns a reference.
   *
   * One per runner rather than one per deployment version. A shared Secret has
   * to outlive whichever runners still hold it, and the collector decides that
   * from owners it may have read before the newest was added, so a delete it
   * already chose still lands and takes the credential from a runner that is
   * starting. Nothing else references a runner's own Secret, so there is no
   * such decision to lose a race with.
   *
   * In the spec the token would be readable by anything holding get on the
   * resource; the kubelet resolves a reference, so the operator never reads it.
   */
  private async ensureRunnerToken(
    opts: WorkloadManagerCreateOptions,
    runnerId: string
  ): Promise<{ name: string; key: string; uid?: string } | undefined> {
    if (!opts.deploymentToken) {
      return undefined;
    }

    const name = runnerTokenSecretName(runnerId, opts.deploymentToken);

    try {
      const created = await this.writeTokenSecret(name, opts.deploymentToken);
      return { name, key: TOKEN_KEY, uid: uidOf(created) };
    } catch (err: unknown) {
      // A redrive of this attempt. The name carries the token's digest, so the
      // Secret in the way holds what this runner would have written. No uid
      // back, which keeps the failure path from deleting an object it did not
      // create.
      if (statusCodeOf(err) === 409) {
        return { name, key: TOKEN_KEY };
      }
      // Without the reference the runner falls back to the friendly id and
      // fails authentication in a way that reads as a platform problem.
      this.logger.error("[RunCrdWorkloadManager] Runner token secret failed", {
        name,
        rawError: err,
      });
      throw err;
    }
  }

  private async writeTokenSecret(name: string, token: string) {
    return await this.k8s.core.createNamespacedSecret({
      namespace: this.namespace,
      body: {
        metadata: {
          name,
          namespace: this.namespace,
          labels: {
            "app.kubernetes.io/part-of": "trigger-worker",
            "app.kubernetes.io/component": "runner-token",
          },
        },
        type: "Opaque",
        // Spares the kubelet a watch, and says the token does not change.
        immutable: true,
        stringData: { [TOKEN_KEY]: token },
      },
    });
  }
}

/** The create response is untyped, and an absent uid just skips adoption. */
function uidOf(created: unknown): string | undefined {
  if (typeof created !== "object" || created === null) {
    return undefined;
  }
  const meta = (created as { metadata?: { uid?: unknown } }).metadata;
  return typeof meta?.uid === "string" ? meta.uid : undefined;
}

/**
 * The whole translation from what the platform dequeued into what the API server
 * stores, kept apart from the client because a wrong field here is a pod that
 * starts and behaves differently, not a request that fails.
 */
export function runnerBodyFor(
  opts: WorkloadManagerCreateOptions,
  meta: { name: string; namespace: string; token?: { name: string; key: string } }
) {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "Runner",
    metadata: {
      // The runner id is the name, so a retried attempt collides.
      name: meta.name,
      namespace: meta.namespace,
    },
    spec: {
      runtime: "container",
      // As built, digest and all: the operator owns stripping and rewriting, so
      // they cannot both apply.
      image: opts.image,
      machine: machineOf(opts.machine),
      ...(opts.runtime ? { taskRuntime: opts.runtime } : {}),
      deployment: {
        friendlyID: opts.deploymentFriendlyId,
        version: opts.deploymentVersion,
        ...(meta.token ? { token: meta.token } : {}),
      },
      owner: {
        envID: opts.envId,
        envType: opts.envType satisfies EnvironmentType,
        orgID: opts.orgId,
        projectID: opts.projectId,
      },
      bootstrap: {
        runFriendlyID: opts.runFriendlyId,
        snapshotFriendlyID: opts.snapshotFriendlyId,
        dequeuedAt: opts.dequeuedAt.toISOString(),
      },
      ...(opts.placementTags?.length
        ? {
            // Only the first value has ever reached a node selector.
            placementTags: opts.placementTags.map((tag) => ({
              key: tag.key,
              value: tag.values?.[0] ?? "",
            })),
          }
        : {}),
      // Carried, not derived: it decides affinity for every run this runner
      // later serves.
      ...(isScheduledRun(opts) ? { isScheduledRun: true } : {}),
      ...(opts.hasPrivateLink ? { hasPrivateLink: true } : {}),
    },
  };
}

/**
 * Decimal gigabytes, as the preset table is written: no integer count of binary
 * MiB equals a quarter of a gigabyte.
 */
function machineOf(machine: MachinePreset) {
  return {
    name: machine.name,
    cpu: `${machine.cpu}`,
    memory: `${machine.memory}G`,
  };
}

function isScheduledRun(opts: WorkloadManagerCreateOptions): boolean {
  return opts.annotations?.rootTriggerSource === "schedule";
}

/**
 * One Secret per runner, and per token. The runner id is already what the
 * Runner object is named, so it is a legal DNS subdomain and unique to the
 * attempt; it is lowercased here anyway because a Secret name has no second
 * chance at it. The digest is in the name because the Secret is immutable, so a
 * rotated signing key or a moved expiry has to land as a new Secret rather than
 * a write the old one rejects.
 *
 * The runner id is mixed into the digest so that two runners sharing a
 * deployment token do not end up with matching suffixes, which would let a
 * listing say which runners hold the same credential. It does not stop someone
 * checking a token they already hold against a name, since the id is in the
 * name as well; that would need a salt this process does not have.
 */
export function runnerTokenSecretName(runnerId: string, token: string): string {
  const id = runnerId.toLowerCase();
  const digest = createHash("sha256").update(`${id}:${token}`).digest("hex").slice(0, 8);
  return `${id}-token-${digest}`;
}

/** The client reports a status in several shapes depending on which layer raised it. */
function statusCodeOf(err: unknown): number | undefined {
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
