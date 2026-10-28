import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getRunnerId } from "../util.js";
import { RunCrdWorkloadManager, runnerBodyFor, runnerTokenSecretName } from "./runCrd.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

/** A kubeconfig for a local kind cluster with the Runner CRD installed; the test makes a namespace of its own. */
const KUBECONFIG = process.env.RUN_CRD_TEST_KUBECONFIG;
const NAMESPACE = `v4-runs-test-${randomBytes(4).toString("hex")}`;
const GROUP = "compute.trigger.dev";
const VERSION = "v1alpha1";
const PLURAL = "runners";
const TEMPLATE_KEY = "4f2b1c0e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c";
const TOKEN = "tok_cluster_test";
/** Long enough for a create forwarded after its answer to commit before the second look. */
const SETTLE_MS = 3_000;
/** A wait that outlasts the second look. */
const PAST_SETTLE_MS = 3 * SETTLE_MS;

vi.setConfig({ testTimeout: 60_000 });

/**
 * What this test's proxy does to the next Runner create: answers it as a proxy that lost its
 * upstream would, after forwarding the request, without forwarding it, or forwarding it that
 * many milliseconds after answering; or holds it while something else runs, then forwards it.
 */
type Fault = { forward: boolean | number; answer: number | "cut" } | { hold: () => Promise<void> };

type Upstream = { status: number; headers: IncomingMessage["headers"]; body: Buffer };

/**
 * The manager against a real Kubernetes API, through a proxy of this test's own that speaks to
 * the apiserver as a ServiceAccount bound to a mirror of the chart's Role, and that answers a
 * Runner create with the statuses the apiserver itself never sends.
 */
describe.skipIf(!KUBECONFIG)("RunCrdWorkloadManager against a real Kubernetes API", () => {
  let api: {
    core: k8s.CoreV1Api;
    custom: k8s.CustomObjectsApi;
    rbac: k8s.RbacAuthorizationV1Api;
    authorization: k8s.AuthorizationV1Api;
  };
  let upstream: { url: URL; ca: Buffer; token: string };
  let proxy: Server;
  let dir: string;
  let fault: Fault | undefined;

  beforeAll(async () => {
    if (process.env.KUBERNETES_PORT) {
      throw new Error("refusing to run inside a cluster, where the client ignores KUBECONFIG");
    }
    const cluster = new k8s.KubeConfig();
    cluster.loadFromFile(KUBECONFIG!);
    const context = cluster.getCurrentContext();
    const target = cluster.getCurrentCluster()!;
    const url = new URL(target.server);
    if (!context.startsWith("kind-") || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error(
        `refusing to test against ${context} at ${url.host}, not a local kind cluster`
      );
    }
    api = {
      core: cluster.makeApiClient(k8s.CoreV1Api),
      custom: cluster.makeApiClient(k8s.CustomObjectsApi),
      rbac: cluster.makeApiClient(k8s.RbacAuthorizationV1Api),
      authorization: cluster.makeApiClient(k8s.AuthorizationV1Api),
    };
    await api.core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    upstream = { url, ca: Buffer.from(target.caData!, "base64"), token: await supervisorToken() };
    // The proxy serves the admin's client certificate, which the manager is told not to verify.
    const user = cluster.getCurrentUser()!;
    proxy = createServer(
      { cert: Buffer.from(user.certData!, "base64"), key: Buffer.from(user.keyData!, "base64") },
      (req, res) => void relay(req, res)
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;
    dir = mkdtempSync(join(tmpdir(), "run-crd-cluster-"));
    const kubeconfig = join(dir, "config");
    writeFileSync(
      kubeconfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "proxy",
            cluster: { server: `https://127.0.0.1:${port}`, "insecure-skip-tls-verify": true },
          },
        ],
        users: [{ name: "proxy", user: {} }],
        contexts: [{ name: "proxy", context: { cluster: "proxy", user: "proxy" } }],
        "current-context": "proxy",
      })
    );
    vi.stubEnv("KUBECONFIG", kubeconfig);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (api) {
      await api.core.deleteNamespace({ name: NAMESPACE });
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    fault = undefined;
  });

  /** A token for a ServiceAccount bound to a copy of the supervisor's Role in the Helm chart. */
  async function supervisorToken() {
    const name = "supervisor";
    await api.core.createNamespacedServiceAccount({
      namespace: NAMESPACE,
      body: { metadata: { name } },
    });
    await api.rbac.createNamespacedRole({
      namespace: NAMESPACE,
      body: {
        metadata: { name },
        rules: [
          { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete", "patch"] },
          {
            apiGroups: [GROUP],
            resources: [PLURAL],
            verbs: ["create", "delete", "get", "list", "patch", "watch"],
          },
        ],
      },
    });
    await api.rbac.createNamespacedRoleBinding({
      namespace: NAMESPACE,
      body: {
        metadata: { name },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
        subjects: [{ kind: "ServiceAccount", name, namespace: NAMESPACE }],
      },
    });
    // The authorizer learns of the binding through an informer.
    await vi.waitFor(
      async () => {
        const review = await api.authorization.createSubjectAccessReview({
          body: {
            spec: {
              user: `system:serviceaccount:${NAMESPACE}:${name}`,
              resourceAttributes: { namespace: NAMESPACE, verb: "create", resource: "secrets" },
            },
          },
        });
        expect(review.status?.allowed, "the RoleBinding never reached the authorizer").toBe(true);
      },
      { timeout: 10_000, interval: 100 }
    );
    const issued = await api.core.createNamespacedServiceAccountToken({
      name,
      namespace: NAMESPACE,
      body: { spec: { audiences: [], expirationSeconds: 3600 } },
    });
    return issued.status!.token;
  }

  async function relay(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, upstream.url);
    const current =
      req.method === "POST" && url.pathname.endsWith(`/${PLURAL}`) ? fault : undefined;
    try {
      const body = await collect(req);
      const send = () => sendUpstream(req.method!, url, req.headers, body);
      if (current === undefined) {
        return passThrough(res, await send());
      }
      // Cleared before a hold runs, so the creates it makes pass through unfaulted.
      fault = undefined;
      if ("hold" in current) {
        await current.hold();
        return passThrough(res, await send());
      }
      if (typeof current.forward === "number") {
        setTimeout(() => void send().catch(console.error), current.forward);
      } else if (current.forward) {
        await send();
      }
      failWith(res, current.answer);
    } catch (error) {
      res.writeHead(502);
      res.end(String(error));
    }
  }

  function sendUpstream(
    method: string,
    url: URL,
    headers: IncomingMessage["headers"],
    body: Buffer
  ) {
    return new Promise<Upstream>((resolve, reject) => {
      const sent = request(
        url,
        {
          method,
          headers: {
            ...withContentLength(headers, body),
            host: url.host,
            authorization: `Bearer ${upstream.token}`,
          },
          ca: upstream.ca,
        },
        (incoming) => {
          collect(incoming).then(
            (data) =>
              resolve({ status: incoming.statusCode!, headers: incoming.headers, body: data }),
            reject
          );
        }
      );
      sent.on("error", reject);
      sent.end(body);
    });
  }

  function passThrough(res: ServerResponse, from: Upstream) {
    res.writeHead(from.status, withContentLength(from.headers, from.body));
    res.end(from.body);
  }

  function failWith(res: ServerResponse, how: number | "cut") {
    if (how === "cut") {
      res.destroy();
      return;
    }
    res.writeHead(how, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        code: how,
        message: `faulted ${how}`,
      })
    );
  }

  /** The headers for a body sent whole, where the stream may have been chunked. */
  function withContentLength(headers: IncomingMessage["headers"], body: Buffer) {
    const sent = { ...headers, "content-length": String(body.length) };
    delete sent["transfer-encoding"];
    return sent;
  }

  async function collect(stream: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function manager() {
    return new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: NAMESPACE,
      runtime: "microvm",
      tokenSecretSettleMs: SETTLE_MS,
    });
  }

  /** A cold start of a run of its own, so names never collide across tests. */
  function options(
    overrides: Partial<WorkloadManagerCreateOptions> = {}
  ): WorkloadManagerCreateOptions & { runnerId: string; secretName: string } {
    const runFriendlyId = overrides.runFriendlyId ?? `run_${randomBytes(6).toString("hex")}`;
    const runnerId = getRunnerId(runFriendlyId);
    return {
      image: "registry.example.com/proj/worker:20260827.1@sha256:" + "0".repeat(64),
      templateKey: TEMPLATE_KEY,
      machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
      version: "20260827.1",
      dequeuedAt: new Date(),
      envId: "env_abc",
      envType: "PRODUCTION",
      orgId: "org_abc",
      projectId: "proj_abc",
      deploymentFriendlyId: "deployment_abc",
      deploymentVersion: "20260827.1",
      deploymentToken: TOKEN,
      runId: "run_internal",
      runFriendlyId,
      snapshotId: "snapshot_internal",
      snapshotFriendlyId: "snapshot_abc",
      ...overrides,
      runnerId,
      secretName: runnerTokenSecretName(runnerId, TOKEN),
    };
  }

  async function runner(name: string) {
    return (await api.custom.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURAL,
      name,
    })) as {
      metadata: { uid: string };
      spec: {
        bootstrap?: { snapshotFriendlyID: string };
        deployment: { token?: { name: string } };
      };
    };
  }

  async function secret(name: string) {
    return await api.core.readNamespacedSecret({ name, namespace: NAMESPACE });
  }

  /** The runner's token Secrets, by name and the uids of their owners. */
  async function secretsOf(runnerId: string) {
    const list = await api.core.listNamespacedSecret({
      namespace: NAMESPACE,
      labelSelector: "app.kubernetes.io/component=runner-token",
    });
    return list.items
      .filter((item) => item.metadata!.name!.startsWith(`${runnerId}-token-`))
      .map((item) => ({
        name: item.metadata!.name!,
        owners: (item.metadata!.ownerReferences ?? []).map((owner) => owner.uid),
      }));
  }

  /** 200 when the read succeeds, else the API's status code. */
  async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return 200;
    } catch (error) {
      return (error as { code?: number }).code;
    }
  }

  function secretGone(name: string, timeout: number) {
    return vi.waitFor(async () => expect(await statusOf(secret(name))).toBe(404), {
      timeout,
      interval: 200,
    });
  }

  it("creates the Runner with a reference to its token Secret and adopts the Secret", async () => {
    const opts = options();
    await manager().create(opts);
    const created = await runner(opts.runnerId);
    expect(created.spec.deployment.token).toMatchObject({ name: opts.secretName });
    const adopted = await secret(opts.secretName);
    expect(adopted.immutable).toBe(true);
    expect(adopted.metadata?.ownerReferences).toMatchObject([
      { kind: "Runner", name: opts.runnerId, uid: created.metadata.uid },
    ]);
  });

  it.each([408, 503])(
    "adopts the Secret for the Runner the create made when it was forwarded and answered with a %s, and a redelivery leaves it to that Runner",
    async (code) => {
      const opts = options();
      fault = { forward: true, answer: code };
      await expect(manager().create(opts)).rejects.toMatchObject({ code });
      const created = await runner(opts.runnerId);
      expect(created.spec.deployment.token).toMatchObject({ name: opts.secretName });
      expect(await secretsOf(opts.runnerId)).toEqual([
        { name: opts.secretName, owners: [created.metadata.uid] },
      ]);

      await manager().create(opts);
      expect(await secretsOf(opts.runnerId)).toEqual([
        { name: opts.secretName, owners: [created.metadata.uid] },
      ]);
    }
  );

  it("adopts the Secret for the Runner the create made when its answer never came", async () => {
    const opts = options();
    fault = { forward: true, answer: "cut" };
    await expect(manager().create(opts)).rejects.toThrow();
    const created = await runner(opts.runnerId);
    expect(await secretsOf(opts.runnerId)).toEqual([
      { name: opts.secretName, owners: [created.metadata.uid] },
    ]);
  });

  it("adopts the Secret at the second look for a Runner that committed after the first", async () => {
    const opts = options();
    fault = { forward: SETTLE_MS / 3, answer: 503 };
    await expect(manager().create(opts)).rejects.toMatchObject({ code: 503 });
    await vi.waitFor(
      async () => {
        const created = await runner(opts.runnerId);
        expect(await secretsOf(opts.runnerId), "the second look never adopted the Secret").toEqual([
          { name: opts.secretName, owners: [created.metadata.uid] },
        ]);
      },
      { timeout: PAST_SETTLE_MS, interval: 200 }
    );
  });

  it.each([403, 422])(
    "deletes the Secret it wrote, after a second look, when the apiserver refused the Runner create with a %s",
    async (code) => {
      const opts = options();
      fault = { forward: false, answer: code };
      await expect(manager().create(opts)).rejects.toMatchObject({ code });
      expect(await statusOf(runner(opts.runnerId))).toBe(404);
      expect(await statusOf(secret(opts.secretName))).toBe(200);
      await secretGone(opts.secretName, PAST_SETTLE_MS);
    }
  );

  it("keeps the Secret for the Runner that won the name when the losing create is forwarded after it", async () => {
    const opts = options();
    let winner: string | undefined;
    // B wins the race between A's Secret write and A's Runner create, reusing A's Secret.
    fault = {
      hold: async () => {
        await manager().create(opts);
        winner = (await runner(opts.runnerId)).metadata.uid;
      },
    };

    await manager().create(opts);

    expect((await runner(opts.runnerId)).metadata.uid).toBe(winner);
    expect(await secretsOf(opts.runnerId)).toEqual([{ name: opts.secretName, owners: [winner] }]);
  });

  it("writes the Secret again, owned, for a redelivery whose reused Secret a second look took meanwhile", async () => {
    const opts = options();
    fault = { forward: false, answer: 503 };
    await expect(manager().create(opts)).rejects.toMatchObject({ code: 503 });

    // The redelivery reuses the Secret; its create is held until the second look deletes it.
    fault = { hold: () => secretGone(opts.secretName, PAST_SETTLE_MS) };
    await manager().create(opts);

    const created = await runner(opts.runnerId);
    expect(await secretsOf(opts.runnerId)).toEqual([
      { name: opts.secretName, owners: [created.metadata.uid] },
    ]);
    expect((await secret(opts.secretName)).data?.token).toBe(Buffer.from(TOKEN).toString("base64"));
  });

  it("gives a replacement a Secret of its own, apart from the one the replaced Runner owns", async () => {
    const opts = options({ snapshotFriendlyId: "snapshot_later" });
    const earlier = options({
      runFriendlyId: opts.runFriendlyId,
      snapshotFriendlyId: "snapshot_earlier",
      dequeuedAt: new Date(Date.now() - 60_000),
    });
    const replaced = (await api.custom.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURAL,
      body: runnerBodyFor(earlier, {
        name: opts.runnerId,
        namespace: NAMESPACE,
        runtime: "microvm",
        token: { name: opts.secretName, key: "token" },
      }),
    })) as { metadata: { uid: string } };
    await api.core.createNamespacedSecret({
      namespace: NAMESPACE,
      body: {
        metadata: {
          name: opts.secretName,
          labels: { "app.kubernetes.io/component": "runner-token" },
          ownerReferences: [
            {
              apiVersion: `${GROUP}/${VERSION}`,
              kind: "Runner",
              name: opts.runnerId,
              uid: replaced.metadata.uid,
            },
          ],
        },
        type: "Opaque",
        immutable: true,
        stringData: { token: TOKEN },
      },
    });

    await manager().create(opts);

    const replacement = await runner(opts.runnerId);
    expect(replacement.spec.bootstrap?.snapshotFriendlyID).toBe("snapshot_later");
    await vi.waitFor(
      async () => {
        const left = await secretsOf(opts.runnerId);
        expect(left, "the collector never took the replaced Runner's Secret").toEqual([
          { name: expect.any(String), owners: [replacement.metadata.uid] },
        ]);
        expect(left[0]!.name).not.toBe(opts.secretName);
      },
      { timeout: 30_000, interval: 200 }
    );
  });

  it("lets the collector take an adopted Secret with its Runner", async () => {
    const opts = options();
    await manager().create(opts);
    expect(await statusOf(secret(opts.secretName))).toBe(200);

    await api.custom.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURAL,
      name: opts.runnerId,
    });

    await secretGone(opts.secretName, 30_000);
  });
});
