import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getRunnerId } from "../util.js";
import { RunCrdWorkloadManager, runnerTokenSecretName } from "./runCrd.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

/** A kubeconfig for a cluster with the Runner CRD installed, such as a kind cluster; the test makes a namespace of its own. */
const KUBECONFIG = process.env.RUN_CRD_TEST_KUBECONFIG;
const NAMESPACE = `v4-runs-test-${randomBytes(4).toString("hex")}`;
const GROUP = "compute.trigger.dev";
const VERSION = "v1alpha1";
const PLURAL = "runners";
const TEMPLATE_KEY = "4f2b1c0e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c";
const TOKEN = "tok_cluster_test";

/** What this test's proxy does to a Runner create: forwards it or not, then answers as a proxy that lost its upstream would. */
type Fault = { forward: boolean; answer: number | "cut" };

/**
 * The manager against a real Kubernetes API, reached through a proxy of this test's own: the
 * statuses that matter for the token Secret's fate are ones the apiserver itself never sends,
 * so the proxy forwards the Runner create and then answers the client with them.
 */
describe.skipIf(!KUBECONFIG)("RunCrdWorkloadManager against a real Kubernetes API", () => {
  const cluster = new k8s.KubeConfig();
  let api: { core: k8s.CoreV1Api; custom: k8s.CustomObjectsApi };
  let upstream: { url: URL; ca: Buffer; cert: Buffer; key: Buffer };
  let proxy: Server;
  let fault: Fault | undefined;
  let dir: string;
  let previousKubeconfig: string | undefined;
  const runners: string[] = [];
  const secrets: string[] = [];

  beforeAll(async () => {
    cluster.loadFromFile(KUBECONFIG!);
    api = {
      core: cluster.makeApiClient(k8s.CoreV1Api),
      custom: cluster.makeApiClient(k8s.CustomObjectsApi),
    };
    await api.core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    const target = cluster.getCurrentCluster()!;
    const user = cluster.getCurrentUser()!;
    upstream = {
      url: new URL(target.server),
      ca: Buffer.from(target.caData!, "base64"),
      cert: Buffer.from(user.certData!, "base64"),
      key: Buffer.from(user.keyData!, "base64"),
    };
    dir = mkdtempSync(join(tmpdir(), "run-crd-cluster-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" }
    );
    proxy = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, relay);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;
    const kubeconfig = join(dir, "config");
    writeFileSync(
      kubeconfig,
      [
        "apiVersion: v1",
        "kind: Config",
        "clusters:",
        "- name: proxy",
        "  cluster:",
        `    server: https://127.0.0.1:${port}`,
        "    insecure-skip-tls-verify: true",
        "users:",
        "- name: proxy",
        "  user: {}",
        "contexts:",
        "- name: proxy",
        "  context:",
        "    cluster: proxy",
        "    user: proxy",
        "current-context: proxy",
        "",
      ].join("\n")
    );
    previousKubeconfig = process.env.KUBECONFIG;
    process.env.KUBECONFIG = kubeconfig;
  });

  afterAll(async () => {
    if (previousKubeconfig === undefined) {
      delete process.env.KUBECONFIG;
    } else {
      process.env.KUBECONFIG = previousKubeconfig;
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    await api.core.deleteNamespace({ name: NAMESPACE });
  });

  afterEach(async () => {
    fault = undefined;
    for (const name of runners.splice(0)) {
      await api.custom
        .deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural: PLURAL,
          name,
        })
        .catch(() => {});
    }
    for (const name of secrets.splice(0)) {
      await api.core.deleteNamespacedSecret({ name, namespace: NAMESPACE }).catch(() => {});
    }
  });

  function relay(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", upstream.url);
    const runnerCreate = req.method === "POST" && url.pathname.endsWith(`/${PLURAL}`);
    const current = fault;
    if (runnerCreate && current && !current.forward) {
      req.resume();
      answer(res, current.answer);
      return;
    }
    const forwarded = request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        ca: upstream.ca,
        cert: upstream.cert,
        key: upstream.key,
      },
      (reply) => {
        if (runnerCreate && current) {
          reply.resume();
          reply.on("end", () => answer(res, current.answer));
          return;
        }
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      }
    );
    forwarded.on("error", (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    req.pipe(forwarded);
  }

  function answer(res: ServerResponse, how: number | "cut") {
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

  function manager() {
    return new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: NAMESPACE,
      runtime: "microvm",
    });
  }

  /** A cold start of a run of its own, so names never collide across tests. */
  function options(): WorkloadManagerCreateOptions & { runnerId: string; secretName: string } {
    const runFriendlyId = `run_${randomBytes(6).toString("hex")}`;
    const runnerId = getRunnerId(runFriendlyId);
    const secretName = runnerTokenSecretName(runnerId, TOKEN);
    runners.push(runnerId);
    secrets.push(secretName);
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
      runnerId,
      secretName,
    };
  }

  async function runner(name: string) {
    return (await api.custom.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURAL,
      name,
    })) as { metadata: { uid: string }; spec: { deployment: { token?: { name: string } } } };
  }

  async function secret(name: string) {
    return await api.core.readNamespacedSecret({ name, namespace: NAMESPACE });
  }

  /** 200 when the read succeeds, else the API's status code. */
  async function status(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return 200;
    } catch (error) {
      return (error as { code?: number }).code;
    }
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
    "keeps the Secret when the Runner create was forwarded and answered with a %s, so the Runner it made can start",
    async (code) => {
      const opts = options();
      fault = { forward: true, answer: code };
      await expect(manager().create(opts)).rejects.toMatchObject({ code });
      const created = await runner(opts.runnerId);
      expect(created.spec.deployment.token).toMatchObject({ name: opts.secretName });
      expect(await status(secret(opts.secretName))).toBe(200);

      // The redelivery finds the Runner in the way and leaves the Secret, which it did not write, in place.
      fault = undefined;
      await manager().create(opts);
      expect(await status(secret(opts.secretName))).toBe(200);
    }
  );

  it("keeps the Secret when the Runner create's answer never came", async () => {
    const opts = options();
    fault = { forward: true, answer: "cut" };
    await expect(manager().create(opts)).rejects.toThrow();
    expect(await status(runner(opts.runnerId))).toBe(200);
    expect(await status(secret(opts.secretName))).toBe(200);
  });

  it.each([403, 422])(
    "deletes the Secret it wrote when the apiserver refused the Runner create with a %s",
    async (code) => {
      const opts = options();
      fault = { forward: false, answer: code };
      await expect(manager().create(opts)).rejects.toMatchObject({ code });
      expect(await status(runner(opts.runnerId))).toBe(404);
      expect(await status(secret(opts.secretName))).toBe(404);
    }
  );
});
