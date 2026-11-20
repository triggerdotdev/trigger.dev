import {
  ApiextensionsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObjectApi,
  loadYaml,
  type V1CustomResourceDefinition,
} from "@kubernetes/client-node";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { getRestoreRunnerId, getRunnerId } from "../../util.js";
import type { SecretProxyCaller } from "../secretProxyBindings.js";

const exec = promisify(execFile);
const K3S_IMAGE =
  "rancher/k3s:v1.32.4-k3s1@sha256:1b71c68b063364bab469452eb9cc27edcb2767273f1aca5582db3586a3927483";
const PAUSE_IMAGE =
  "rancher/mirrored-pause:3.6@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893";
// Never pullable, so its container stays waiting: a Pod with an IP and no running container.
const UNPULLABLE_IMAGE = "registry.invalid/secret-proxy/never-pulled:0";
const STARTUP_TIMEOUT_MS = 180_000;
const INTERCEPTOR_GRACE_MS = 5_000;
const INTERCEPTOR_EXIT_TIMEOUT_MS = 10_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000;
const cargo = process.env.SECRET_PROXY_CARGO ?? join(homedir(), ".cargo/bin/cargo");
const toolchain = process.env.SECRET_PROXY_RUST_TOOLCHAIN ?? "1.97.0";
const fcrunDirectory = fileURLToPath(new URL("../../../../../../compute/fcrun/", import.meta.url));
const runnerCrd = fileURLToPath(
  new URL(
    "../../../../../../compute/operator/config/crd/compute.trigger.dev_runners.yaml",
    import.meta.url
  )
);

export const deploymentClaims = {
  ver: 1 as const,
  deployment: "deployment_test",
  deployment_version: "1",
  environment_id: "env_test",
  environment_type: "PRODUCTION" as const,
  org_id: "org_test",
  project_id: "proj_test",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

export function executionInput(
  caller: SecretProxyCaller,
  attempt = 1,
  allowedHosts = ["api.example.com"],
  expiresAt = deploymentClaims.exp
) {
  const payload = {
    run_id: caller.runId,
    attempt,
    environment_id: caller.claims?.environment_id ?? deploymentClaims.environment_id,
    deployment_id: caller.claims?.deployment ?? deploymentClaims.deployment,
    exp: expiresAt,
  };
  return {
    proxy: { runId: caller.runId, attempt, expiresAtMs: payload.exp * 1000, allowedHosts },
    runToken: `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`,
  };
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  description: string
): Promise<T> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

function controlHealth(socketPath: string) {
  return new Promise<boolean>((resolve, reject) => {
    const req = request({ socketPath, path: "/health", timeout: 1000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Control health timeout")));
    req.end();
  });
}

function runnerName(runId: string, attempt?: number, checkpoint?: string) {
  return checkpoint ? getRestoreRunnerId(runId, checkpoint) : getRunnerId(runId, attempt);
}

export type FixtureAllocation = {
  allocationId: string;
  guestId: string;
  runId: string;
  attempt: number;
};

export class AllocationOwner {
  private readonly child: ChildProcess;
  private tail: Promise<unknown> = Promise.resolve();
  private pending?: {
    resolve: (value: { listen?: string }) => void;
    reject: (error: Error) => void;
  };

  constructor(binary: string, socketPath: string) {
    this.child = spawn(binary, [socketPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.resume();
    const fail = () => this.pending?.reject(new Error("Allocation owner fixture exited"));
    this.child.on("error", fail);
    this.child.on("exit", fail);
    this.child.stdin!.on("error", fail);
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (!response.ok) throw new Error(response.error ?? "Allocation handoff failed");
        this.pending?.resolve(response);
      } catch (error) {
        this.pending?.reject(error as Error);
      }
    });
  }

  private command(command: object): Promise<{ listen?: string }> {
    const next = this.tail.then(
      () =>
        new Promise<{ listen?: string }>((resolve, reject) => {
          if (this.child.exitCode !== null || this.child.signalCode !== null)
            return reject(new Error("Allocation owner fixture exited"));
          const timer = setTimeout(() => {
            this.child.kill("SIGKILL");
            this.pending?.reject(new Error("Allocation owner fixture timed out"));
          }, INTERCEPTOR_EXIT_TIMEOUT_MS);
          this.pending = {
            resolve: (value) => {
              clearTimeout(timer);
              this.pending = undefined;
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              this.pending = undefined;
              reject(error);
            },
          };
          this.child.stdin!.write(`${JSON.stringify(command)}\n`, (error) => {
            if (error) this.pending?.reject(error);
          });
        })
    );
    this.tail = next.catch(() => {});
    return next;
  }

  async register(allocation: FixtureAllocation, listen = "127.0.0.1:0"): Promise<string> {
    const response = await this.command({ op: "register", ...allocation, listen });
    if (typeof response.listen !== "string") throw new Error("Missing allocation listener address");
    return response.listen;
  }

  async retire(allocationId: string): Promise<void> {
    await this.command({ op: "retire", allocationId });
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit", {
      signal: AbortSignal.timeout(INTERCEPTOR_EXIT_TIMEOUT_MS),
    });
    const forceKill = setTimeout(() => this.child.kill("SIGKILL"), INTERCEPTOR_GRACE_MS);
    try {
      this.child.stdin!.end();
      await exited;
    } finally {
      clearTimeout(forceKill);
    }
  }
}

export class SecretProxyFixture {
  readonly namespace = "secret-proxy-bindings";
  readonly config = new KubeConfig();
  core!: CoreV1Api;
  custom!: CustomObjectsApi;
  nodeName!: string;
  socketPath!: string;
  private directory?: string;
  private readonly containerName = `secret-proxy-bindings-${randomUUID()}`;
  private containerId?: string;
  private interceptor?: ChildProcess;
  private interceptorLog = "";
  private owner?: AllocationOwner;
  private readonly placementsByRunner = new Map<string, FixtureAllocation>();
  private readonly allocations = new Map<string, { metadata: FixtureAllocation; listen: string }>();

  async start() {
    try {
      const results = await Promise.allSettled([this.startKubernetes(), this.startInterceptor()]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Fixture startup and cleanup failed");
      }
      throw error;
    }
  }

  private async startKubernetes() {
    const { stdout } = await exec(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        this.containerName,
        "--rm",
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
        "--kubelet-arg=max-pods=160",
      ],
      { timeout: STARTUP_TIMEOUT_MS }
    );
    this.containerId = stdout.trim();
    try {
      const kubeconfig = await waitFor(async () => {
        try {
          const result = await exec(
            "docker",
            ["exec", this.containerId!, "kubectl", "config", "view", "--raw"],
            { timeout: 10_000 }
          );
          return result.stdout.includes("client-certificate-data") ? result.stdout : undefined;
        } catch {
          // exec errors retain stdout, which can contain private key material.
          return undefined;
        }
      }, "k3s kubeconfig");
      const inspect = await exec("docker", ["inspect", this.containerId]);
      const port = JSON.parse(inspect.stdout)[0].NetworkSettings.Ports["6443/tcp"][0].HostPort;
      this.config.loadFromString(
        kubeconfig.replace("https://127.0.0.1:6443", `https://127.0.0.1:${port}`)
      );
      this.core = this.config.makeApiClient(CoreV1Api);
      this.custom = this.config.makeApiClient(CustomObjectsApi);
      this.nodeName = await waitFor(async () => {
        const nodes = await this.core.listNode();
        return nodes.items.find((node) =>
          node.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True"
          )
        )?.metadata?.name;
      }, "ready k3s node");
      const crds = this.config.makeApiClient(ApiextensionsV1Api);
      const runnerDefinition = loadYaml<V1CustomResourceDefinition>(
        await readFile(runnerCrd, "utf8")
      );
      for (const version of runnerDefinition.spec.versions) {
        const properties = version.schema?.openAPIV3Schema?.properties?.spec?.properties;
        if (!properties) throw new Error("Runner fixture requires a spec schema");
        properties.singleUse ??= { type: "boolean" };
      }
      // The generic client preserves CRD schema extension keys verbatim.
      await KubernetesObjectApi.makeApiClient(this.config).create(runnerDefinition);
      await waitFor(async () => {
        const crd = await crds.readCustomResourceDefinition({
          name: "runners.compute.trigger.dev",
        });
        return crd.status?.conditions?.some(
          (condition) => condition.type === "Established" && condition.status === "True"
        )
          ? true
          : undefined;
      }, "Runner CRD");
      await this.core.createNamespace({ body: { metadata: { name: this.namespace } } });
      await waitFor(async () => {
        await this.core.readNamespacedServiceAccount({
          namespace: this.namespace,
          name: "default",
        });
        return true;
      }, "namespace service account");
    } catch (error) {
      // Raw k3s startup logs can include join credentials.
      throw new Error("Isolated k3s fixture failed", { cause: error });
    }
  }

  private async startInterceptor() {
    await exec(
      cargo,
      [
        `+${toolchain}`,
        "build",
        "--locked",
        "-p",
        "fcrun-interceptor",
        "--target-dir",
        join(fcrunDirectory, "target"),
      ],
      {
        cwd: fcrunDirectory,
        timeout: 600_000,
        env: { ...process.env, PATH: `${dirname(cargo)}:${process.env.PATH}` },
      }
    );
    this.directory = await mkdtemp(join(tmpdir(), "sp-real-"));
    await chmod(this.directory, 0o700);
    const keyPath = join(this.directory, "ca.key");
    const certPath = join(this.directory, "ca.pem");
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=binding-test-root",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await chmod(keyPath, 0o600);
    const caFile = join(this.directory, "interception-ca.pem");
    await writeFile(
      caFile,
      (await readFile(certPath, "utf8")) + (await readFile(keyPath, "utf8")),
      {
        mode: 0o600,
      }
    );
    const tokenPath = join(this.directory, "node-token");
    await writeFile(tokenPath, "isolated-binding-test-node", { mode: 0o600 });
    this.socketPath = join(this.directory, "control.sock");
    const configPath = join(this.directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        controlSocket: this.socketPath,
        caFile,
        relayUrl: "https://localhost:1",
        relayRootCa: certPath,
        nodeTokenFile: tokenPath,
      })
    );
    this.interceptor = spawn(join(fcrunDirectory, "target/debug/fcrun-interceptor"), [configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.interceptor.stdout!.on("data", (chunk) => {
      this.interceptorLog += chunk;
    });
    this.interceptor.stderr!.on("data", (chunk) => {
      this.interceptorLog += chunk;
    });
    await once(this.interceptor, "spawn");
    await waitFor(async () => {
      if (this.interceptor!.exitCode !== null) throw new Error(this.interceptorLog);
      return (await controlHealth(this.socketPath)) ? true : undefined;
    }, "native interceptor control socket");
    this.owner = new AllocationOwner(
      join(fcrunDirectory, "target/debug/allocation-fixture"),
      this.socketPath
    );
  }

  /**
   * A Runner and Pod whose container never starts (unpullable image), so the Pod has an IP but
   * no running container: the state a guest can call start in before kubelet publishes status.
   */
  async pendingPlacement(runId: string, claims = deploymentClaims): Promise<SecretProxyCaller> {
    const name = runnerName(runId);
    await this.createPlacement(name, runId, claims, UNPULLABLE_IMAGE);
    const pod = await waitFor(async () => {
      const current = await this.core.readNamespacedPod({ name, namespace: this.namespace });
      return current.status?.podIP ? current : undefined;
    }, "pending placement Pod IP");
    return { runId, runnerId: name, claims, sourceIp: pod.status!.podIP! };
  }

  private async createPlacement(
    name: string,
    runId: string,
    claims: typeof deploymentClaims,
    image: string,
    { singleUse, checkpoint }: { singleUse?: boolean; checkpoint?: string } = {}
  ) {
    const runner = (await this.custom.createNamespacedCustomObject({
      group: "compute.trigger.dev",
      version: "v1alpha1",
      plural: "runners",
      namespace: this.namespace,
      body: {
        apiVersion: "compute.trigger.dev/v1alpha1",
        kind: "Runner",
        metadata: { name },
        spec: {
          runtime: "microvm",
          singleUse,
          restore: checkpoint ? { snapshotID: checkpoint, node: this.nodeName } : undefined,
          templateKey: "a".repeat(64),
          image,
          machine: { name: "test", cpu: "0.01", memory: "8Mi" },
          owner: {
            envID: claims.environment_id,
            envType: claims.environment_type,
            orgID: claims.org_id,
            projectID: claims.project_id,
          },
          deployment: { friendlyID: claims.deployment, version: claims.deployment_version },
          bootstrap: {
            runFriendlyID: runId,
            snapshotFriendlyID: "snap_test",
            dequeuedAt: new Date().toISOString(),
          },
        },
      },
    })) as { metadata: { uid: string } };
    await this.core.createNamespacedPod({
      namespace: this.namespace,
      body: {
        metadata: {
          name,
          ownerReferences: [
            {
              apiVersion: "compute.trigger.dev/v1alpha1",
              kind: "Runner",
              name,
              uid: runner.metadata.uid,
              controller: true,
            },
          ],
        },
        spec: {
          nodeName: this.nodeName,
          terminationGracePeriodSeconds: 0,
          containers: [
            {
              name: "run-controller",
              image,
              resources: { requests: { cpu: "1m", memory: "2Mi" } },
            },
          ],
        },
      },
    });
  }

  async placements(
    requests: { runId: string; attempt?: number; singleUse?: boolean; checkpoint?: string }[],
    claims = deploymentClaims
  ): Promise<SecretProxyCaller[]> {
    for (let offset = 0; offset < requests.length; offset += 8) {
      await Promise.all(
        requests.slice(offset, offset + 8).map(({ runId, attempt, singleUse, checkpoint }) =>
          this.createPlacement(runnerName(runId, attempt, checkpoint), runId, claims, PAUSE_IMAGE, {
            singleUse,
            checkpoint,
          })
        )
      );
    }
    const pods = await waitFor(async () => {
      const result = await this.core.listNamespacedPod({ namespace: this.namespace });
      const byName = new Map(result.items.map((pod) => [pod.metadata!.name!, pod]));
      return requests.every(
        ({ runId, attempt, checkpoint }) =>
          byName.get(runnerName(runId, attempt, checkpoint))?.status?.containerStatuses?.[0]?.state
            ?.running
      )
        ? byName
        : undefined;
    }, `${requests.length} running placement pods`);
    return requests.map(({ runId, attempt, checkpoint }) => {
      const runnerId = runnerName(runId, attempt, checkpoint);
      const pod = pods.get(runnerId)!;
      this.placementsByRunner.set(runnerId, {
        allocationId: randomUUID(),
        guestId: pod.status!.containerStatuses![0]!.containerID!.replace(/^containerd:\/\//, ""),
        runId,
        // A restored allocation has no attempt until its first binding.
        attempt: checkpoint ? 0 : (attempt ?? 1),
      });
      return { runId, runnerId, claims, sourceIp: pod.status!.podIP! };
    });
  }

  async resetAllocations() {
    await Promise.all(
      [...this.allocations.keys()].map((runnerId) => this.retireAllocation({ runnerId }))
    );
    for (const runnerId of this.placementsByRunner.keys())
      await this.registerAllocation({ runnerId });
  }

  allocation(caller: Pick<SecretProxyCaller, "runnerId">) {
    const allocation = this.allocations.get(caller.runnerId!);
    if (!allocation) throw new Error("Missing fixture allocation");
    return allocation;
  }

  async registerAllocation(
    caller: Pick<SecretProxyCaller, "runnerId">,
    overrides: Partial<FixtureAllocation> = {}
  ) {
    const metadata = {
      ...this.placementsByRunner.get(caller.runnerId!)!,
      allocationId: randomUUID(),
      ...overrides,
    };
    const listen = await this.owner!.register(metadata);
    this.allocations.set(caller.runnerId!, { metadata, listen });
  }

  async retireAllocation(caller: Pick<SecretProxyCaller, "runnerId">) {
    const { metadata } = this.allocation(caller);
    await this.owner!.retire(metadata.allocationId);
    await waitFor(async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { socketPath: this.socketPath, path: `/allocations/${metadata.guestId}` },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end();
      });
      return status === 404 ? true : undefined;
    }, "allocation owner EOF retirement");
    this.allocations.delete(caller.runnerId!);
  }

  async acceptsTls(caller: SecretProxyCaller, servername = "api.example.com"): Promise<boolean> {
    const { listen } = this.allocation(caller);
    const ca = await readFile(join(this.directory!, "ca.pem"));
    return new Promise((resolve) => {
      const socket = connectTls({
        host: "127.0.0.1",
        port: Number(listen.split(":").at(-1)),
        servername,
        ca,
      });
      const finish = (accepted: boolean) => {
        socket.destroy();
        resolve(accepted);
      };
      socket.setTimeout(2000, () => finish(false));
      socket.once("secureConnect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("close", () => resolve(false));
    });
  }

  pauseInterceptor() {
    if (!this.interceptor?.kill("SIGSTOP")) throw new Error("Could not pause interceptor");
  }

  resumeInterceptor() {
    if (!this.interceptor?.kill("SIGCONT")) throw new Error("Could not resume interceptor");
  }

  private async stopInterceptor() {
    const child = this.interceptor;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit", {
      signal: AbortSignal.timeout(INTERCEPTOR_EXIT_TIMEOUT_MS),
    });
    const forceKill = setTimeout(() => child.kill("SIGKILL"), INTERCEPTOR_GRACE_MS);
    try {
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      await exited;
    } finally {
      clearTimeout(forceKill);
    }
  }

  private async removeContainer() {
    try {
      // The owned name is known even if docker run timed out before returning its ID.
      await exec("docker", ["rm", "--force", this.containerName], {
        timeout: DOCKER_CLEANUP_TIMEOUT_MS,
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (!stderr.includes(`No such container: ${this.containerName}`)) throw error;
    }
    this.containerId = undefined;
  }

  async stop() {
    const results = await Promise.allSettled([
      this.owner?.close(),
      this.stopInterceptor(),
      this.removeContainer(),
      this.directory ? rm(this.directory, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
  }
}
