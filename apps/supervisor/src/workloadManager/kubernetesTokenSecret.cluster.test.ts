import "./testEnvironment.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as k8s from "@kubernetes/client-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { env } from "../env.js";
import { getRunnerId } from "../util.js";
import { KubernetesWorkloadManager } from "./kubernetes.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

const exec = promisify(execFile);
const ENABLED = process.env.POD_TOKEN_SECRET_CLUSTER_TEST === "1";
const K3S_IMAGE =
  "rancher/k3s:v1.32.4-k3s1@sha256:1b71c68b063364bab469452eb9cc27edcb2767273f1aca5582db3586a3927483";
const PAUSE_IMAGE =
  "rancher/mirrored-pause:3.6@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893";
const NAMESPACE = "default";
const TOKEN = "tok_pod_cluster_test";
const SETTLE_MS = 3_000;
const TOKEN_LABELS = {
  "app.kubernetes.io/part-of": "trigger-worker",
  "app.kubernetes.io/component": "runner-token",
};

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

describe.skipIf(!ENABLED)("KubernetesWorkloadManager pod token Secret against a real k3s", () => {
  const containerName = `pod-token-secret-${randomBytes(4).toString("hex")}`;
  let containerId: string | undefined;
  let dir: string;
  let adminConfigPath: string;
  let admin: k8s.KubeConfig;
  let core: k8s.CoreV1Api;
  let createSecretSpy: MockInstance<k8s.CoreV1Api["createNamespacedSecret"]>;

  beforeAll(async () => {
    if (process.env.KUBERNETES_PORT) {
      throw new Error("refusing to run inside a cluster, where the client ignores KUBECONFIG");
    }
    if (env.KUBERNETES_NAMESPACE !== NAMESPACE) {
      throw new Error(`KUBERNETES_NAMESPACE must be ${NAMESPACE} for this suite`);
    }
    const started = await exec("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--privileged",
      "--publish",
      "127.0.0.1::6443",
      K3S_IMAGE,
      "server",
      "--snapshotter=native",
      "--disable",
      "traefik",
      "--disable",
      "servicelb",
      "--disable",
      "metrics-server",
      "--disable",
      "local-storage",
      "--disable",
      "coredns",
      "--disable-network-policy",
    ]);
    containerId = started.stdout.trim();
    const raw = await poll(async () => {
      try {
        const result = await exec("docker", [
          "exec",
          containerId!,
          "kubectl",
          "config",
          "view",
          "--raw",
        ]);
        return result.stdout.includes("client-certificate-data") ? result.stdout : undefined;
      } catch {
        return undefined;
      }
    }, 180_000);
    const inspect = await exec("docker", ["inspect", containerId]);
    const port = JSON.parse(inspect.stdout)[0].NetworkSettings.Ports["6443/tcp"][0].HostPort;
    dir = mkdtempSync(join(tmpdir(), "pod-token-secret-"));
    adminConfigPath = join(dir, "admin");
    writeFileSync(
      adminConfigPath,
      raw.replace("https://127.0.0.1:6443", `https://127.0.0.1:${port}`),
      { mode: 0o600 }
    );
    admin = new k8s.KubeConfig();
    admin.loadFromFile(adminConfigPath);
    core = admin.makeApiClient(k8s.CoreV1Api);
    const nodeName = await poll(async () => {
      const nodes = await core.listNode();
      return nodes.items.find((node) =>
        node.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True"
        )
      )?.metadata?.name;
    }, 180_000);
    await exec("docker", [
      "exec",
      containerId,
      "kubectl",
      "label",
      "node",
      nodeName,
      "nodetype=v4-worker",
    ]);
    await poll(async () => {
      await core.readNamespacedServiceAccount({ name: "default", namespace: NAMESPACE });
      return true;
    }, 60_000);
    createSecretSpy = vi.spyOn(k8s.CoreV1Api.prototype, "createNamespacedSecret");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (containerId) {
      await exec("docker", ["rm", "--force", containerId]).catch(() => undefined);
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    createSecretSpy?.mockClear();
  });

  async function poll<T>(operation: () => Promise<T | undefined>, timeout: number): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await operation();
        if (result !== undefined) {
          return result;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("timed out", { cause: lastError });
  }

  function manager(kubeconfig = adminConfigPath) {
    vi.stubEnv("KUBECONFIG", kubeconfig);
    return new KubernetesWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      podTokenSecretEnabled: true,
      tokenSecretSettleMs: SETTLE_MS,
    });
  }

  function options(
    overrides: Partial<WorkloadManagerCreateOptions> = {}
  ): WorkloadManagerCreateOptions & { podName: string } {
    const runFriendlyId = `run_${randomBytes(6).toString("hex")}`;
    return {
      image: PAUSE_IMAGE,
      machine: { name: "small-1x", cpu: 0.1, memory: 0.1, centsPerMs: 0 },
      version: "20261126.1",
      nextAttemptNumber: 1,
      dequeuedAt: new Date(),
      envId: "env_abc",
      envType: "PRODUCTION",
      orgId: "org_abc",
      projectId: "proj_abc",
      deploymentFriendlyId: "deployment_abc",
      deploymentVersion: "20261126.1",
      deploymentToken: TOKEN,
      runId: "run_internal",
      runFriendlyId,
      snapshotId: "snapshot_internal",
      snapshotFriendlyId: "snapshot_abc",
      ...overrides,
      podName: getRunnerId(runFriendlyId, 1),
    };
  }

  function writtenSecretNames(): string[] {
    return createSecretSpy.mock.calls.map((call) => call[0].body.metadata!.name!);
  }

  async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return 200;
    } catch (error) {
      return (error as { code?: number }).code;
    }
  }

  function secretGone(name: string, timeout: number) {
    return vi.waitFor(
      async () =>
        expect(await statusOf(core.readNamespacedSecret({ name, namespace: NAMESPACE }))).toBe(404),
      { timeout, interval: 200 }
    );
  }

  async function expectAdoptedTokenSecret(podName: string) {
    const pod = await core.readNamespacedPod({ name: podName, namespace: NAMESPACE });
    const entry = pod.spec!.containers[0]!.env!.find(
      (item) => item.name === "TRIGGER_DEPLOYMENT_ID"
    );
    expect(entry?.value).toBeUndefined();
    const secretName = entry?.valueFrom?.secretKeyRef?.name;
    expect(entry?.valueFrom?.secretKeyRef).toEqual({ name: secretName, key: "token" });
    expect(writtenSecretNames()).toEqual([secretName]);
    const secret = await core.readNamespacedSecret({ name: secretName!, namespace: NAMESPACE });
    expect(secret.metadata?.labels).toMatchObject(TOKEN_LABELS);
    expect(secret.immutable).toBe(true);
    expect(Buffer.from(secret.data!.token!, "base64").toString()).toBe(TOKEN);
    expect(secret.metadata?.ownerReferences).toEqual([
      expect.objectContaining({
        apiVersion: "v1",
        kind: "Pod",
        name: podName,
        uid: pod.metadata!.uid,
      }),
    ]);
    return { pod, secretName: secretName! };
  }

  async function containerEnvironment(podName: string) {
    const listed = await poll(async () => {
      const result = await exec("docker", [
        "exec",
        containerId!,
        "crictl",
        "ps",
        "--quiet",
        "--name",
        "run-controller",
        "--label",
        `io.kubernetes.pod.name=${podName}`,
      ]);
      return result.stdout.trim() || undefined;
    }, 30_000);
    const pid = await exec("docker", [
      "exec",
      containerId!,
      "crictl",
      "inspect",
      "--output",
      "go-template",
      "--template",
      "{{.info.pid}}",
      listed.split("\n")[0]!,
    ]);
    const environ = await exec("docker", [
      "exec",
      containerId!,
      "cat",
      `/proc/${pid.stdout.trim()}/environ`,
    ]);
    return environ.stdout.split("\0");
  }

  it("creates the pod with a secretKeyRef to an owned token Secret the container reads", async () => {
    const opts = options();
    await manager().create(opts);

    await expectAdoptedTokenSecret(opts.podName);

    await vi.waitFor(
      async () => {
        const pod = await core.readNamespacedPod({ name: opts.podName, namespace: NAMESPACE });
        expect(pod.status?.phase, JSON.stringify(pod.status?.containerStatuses)).toBe("Running");
      },
      { timeout: 150_000, interval: 500 }
    );
    expect(await containerEnvironment(opts.podName)).toContain(`TRIGGER_DEPLOYMENT_ID=${TOKEN}`);
  });

  it("lets the garbage collector take the token Secret with its pod", async () => {
    const opts = options();
    await manager().create(opts);
    const { pod, secretName } = await expectAdoptedTokenSecret(opts.podName);

    await core.deleteNamespacedPod({
      name: opts.podName,
      namespace: NAMESPACE,
      body: { gracePeriodSeconds: 0, preconditions: { uid: pod.metadata!.uid } },
    });

    await secretGone(secretName, 60_000);
  });

  it("deletes the token Secret after the settle delay when the apiserver rejects the pod spec", async () => {
    const opts = options({ envId: "not a valid label value!" });

    await expect(manager().create(opts)).rejects.toSatisfy((error) =>
      String((error as Error).message ?? error).includes("Invalid value")
    );

    const [secretName] = writtenSecretNames();
    expect(secretName).toMatch(new RegExp(`^${opts.podName}-token-[0-9a-f]{8}$`));
    expect(
      await statusOf(core.readNamespacedPod({ name: opts.podName, namespace: NAMESPACE }))
    ).toBe(404);
    expect(
      await statusOf(core.readNamespacedSecret({ name: secretName!, namespace: NAMESPACE }))
    ).toBe(200);
    await secretGone(secretName!, 10 * SETTLE_MS);
  });

  it("deletes the token Secret when another pod already holds the name", async () => {
    const opts = options();
    await core.createNamespacedPod({
      namespace: NAMESPACE,
      body: {
        metadata: { name: opts.podName },
        spec: {
          nodeSelector: { "kubernetes.io/hostname": "absent" },
          containers: [{ name: "run-controller", image: PAUSE_IMAGE }],
        },
      },
    });

    await expect(manager().create(opts)).rejects.toSatisfy((error) =>
      String((error as Error).message ?? error).includes("already exists")
    );

    const [secretName] = writtenSecretNames();
    expect(secretName).toMatch(new RegExp(`^${opts.podName}-token-[0-9a-f]{8}$`));
    await secretGone(secretName!, 10 * SETTLE_MS);
  });

  it("creates and adopts the token Secret as a service account with no read on Secrets", async () => {
    const name = `supervisor-${randomBytes(3).toString("hex")}`;
    const rbac = admin.makeApiClient(k8s.RbacAuthorizationV1Api);
    const authorization = admin.makeApiClient(k8s.AuthorizationV1Api);
    await core.createNamespacedServiceAccount({
      namespace: NAMESPACE,
      body: { metadata: { name } },
    });
    await rbac.createNamespacedRole({
      namespace: NAMESPACE,
      body: {
        metadata: { name },
        rules: [
          { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete", "patch"] },
          {
            apiGroups: [""],
            resources: ["pods"],
            verbs: ["create", "delete", "get", "list", "watch"],
          },
        ],
      },
    });
    await rbac.createNamespacedRoleBinding({
      namespace: NAMESPACE,
      body: {
        metadata: { name },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
        subjects: [{ kind: "ServiceAccount", name, namespace: NAMESPACE }],
      },
    });
    const user = `system:serviceaccount:${NAMESPACE}:${name}`;
    const allowed = async (verb: string, resource: string) =>
      (
        await authorization.createSubjectAccessReview({
          body: { spec: { user, resourceAttributes: { namespace: NAMESPACE, verb, resource } } },
        })
      ).status?.allowed;
    await vi.waitFor(async () => expect(await allowed("create", "secrets")).toBe(true), {
      timeout: 10_000,
      interval: 100,
    });
    expect(await allowed("get", "secrets")).toBe(false);
    expect(await allowed("list", "secrets")).toBe(false);
    const issued = await core.createNamespacedServiceAccountToken({
      name,
      namespace: NAMESPACE,
      body: { spec: { audiences: [], expirationSeconds: 3600 } },
    });
    const cluster = admin.getCurrentCluster()!;
    const scopedConfigPath = join(dir, name);
    writeFileSync(
      scopedConfigPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "k3s",
            cluster: { server: cluster.server, "certificate-authority-data": cluster.caData },
          },
        ],
        users: [{ name, user: { token: issued.status!.token } }],
        contexts: [{ name, context: { cluster: "k3s", user: name, namespace: NAMESPACE } }],
        "current-context": name,
      }),
      { mode: 0o600 }
    );

    const opts = options();
    await manager(scopedConfigPath).create(opts);

    await expectAdoptedTokenSecret(opts.podName);
  });
});
