import "./testEnvironment.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiException } from "@kubernetes/client-node";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkloadManagerCreateOptions } from "./types.js";
import {
  nodetypeNodeSelector,
  runPodTolerations,
  runnerSecurityContext,
  withReservedSourcePorts,
  withRunnerSeccompProfile,
  withNodeSelector,
} from "./kubernetesPodSpec.js";

const basePodSpec = {
  restartPolicy: "Never" as const,
  automountServiceAccountToken: false,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    fsGroup: 1000,
  },
};

describe("nodetypeNodeSelector", () => {
  it("omits the nodeSelector entirely when the label is empty or unset", () => {
    for (const label of ["", undefined]) {
      expect(nodetypeNodeSelector(label)).toEqual({});
    }
  });

  it("pins to nodetype=<label> when set", () => {
    expect(nodetypeNodeSelector("v4-worker")).toEqual({ nodeSelector: { nodetype: "v4-worker" } });
  });
});

describe("runPodTolerations", () => {
  const worker = [{ key: "dedicated", operator: "Equal", value: "runs", effect: "NoSchedule" }];
  const scheduled = [{ key: "scheduled-runs", operator: "Exists", effect: "NoSchedule" }];

  it("leaves tolerations unset when neither is configured", () => {
    expect(runPodTolerations(undefined, undefined, false)).toBeUndefined();
    expect(runPodTolerations(undefined, undefined, true)).toBeUndefined();
    expect(runPodTolerations([], [], true)).toBeUndefined();
  });

  it("applies the worker tolerations to every run", () => {
    expect(runPodTolerations(worker, undefined, false)).toEqual(worker);
    expect(runPodTolerations(worker, undefined, true)).toEqual(worker);
  });

  it("applies the scheduled-run tolerations on their own, as before this option existed", () => {
    expect(runPodTolerations(undefined, scheduled, true)).toEqual(scheduled);
    expect(runPodTolerations(undefined, scheduled, false)).toBeUndefined();
    expect(runPodTolerations([], scheduled, true)).toEqual(scheduled);
  });

  it("adds the scheduled-run tolerations only for scheduled runs", () => {
    expect(runPodTolerations(worker, scheduled, false)).toEqual(worker);
    expect(runPodTolerations(worker, [], true)).toEqual(worker);
    expect(runPodTolerations(worker, scheduled, true)).toEqual([...worker, ...scheduled]);
  });

  it("appends the org tolerations regardless of run type", () => {
    const org = [{ key: "dedicated", operator: "Equal", value: "org-pool", effect: "NoSchedule" }];

    expect(runPodTolerations(undefined, undefined, false, org)).toEqual(org);
    expect(runPodTolerations(worker, undefined, false, org)).toEqual([...worker, ...org]);
    expect(runPodTolerations(worker, scheduled, true, org)).toEqual([
      ...worker,
      ...scheduled,
      ...org,
    ]);
    expect(runPodTolerations(undefined, undefined, false, [])).toBeUndefined();
  });
});

describe("withNodeSelector", () => {
  const podSpec = { ...basePodSpec, nodeSelector: { nodetype: "v4-worker", paid: "true" } };

  it("returns the pod spec untouched when there is nothing to merge", () => {
    expect(withNodeSelector(podSpec, undefined)).toBe(podSpec);
    expect(withNodeSelector(podSpec, {})).toBe(podSpec);
  });

  it("merges extra entries with existing ones", () => {
    expect(withNodeSelector(podSpec, { machinepool: "dedicated-pool" })).toEqual({
      ...podSpec,
      nodeSelector: { nodetype: "v4-worker", paid: "true", machinepool: "dedicated-pool" },
    });
  });

  it("lets the extra entries win on key collision", () => {
    expect(withNodeSelector(podSpec, { nodetype: "other" }).nodeSelector).toEqual({
      nodetype: "other",
      paid: "true",
    });
  });

  it("adds a nodeSelector to a spec that had none", () => {
    expect(withNodeSelector(basePodSpec, { machinepool: "dedicated-pool" })).toEqual({
      ...basePodSpec,
      nodeSelector: { machinepool: "dedicated-pool" },
    });
  });
});

describe("withRunnerSeccompProfile", () => {
  const base = {
    profilePath: "profiles/example.json",
    runtimes: "node-24-plus" as const,
    runtime: "node-24",
    checkpointsEnabled: true,
  };

  const withProfile = {
    ...basePodSpec,
    securityContext: {
      ...basePodSpec.securityContext,
      seccompProfile: { type: "Localhost", localhostProfile: "profiles/example.json" },
    },
  };

  it("applies the profile to node-24 and above under the default scope", () => {
    for (const runtime of ["node-24", "node-26", "node-30", "experimental-node-24"]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtime })).toMatchObject(
        withProfile
      );
    }
  });

  it("skips older runtimes under the default scope", () => {
    for (const runtime of ["node", "node-22", "bun", undefined, null, ""]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtime })).toBe(basePodSpec);
    }
  });

  it("applies the profile to every runtime under the all scope", () => {
    for (const runtime of ["node", "node-22", "bun", "node-24", undefined]) {
      expect(
        withRunnerSeccompProfile(basePodSpec, { ...base, runtimes: "all", runtime })
      ).toMatchObject(withProfile);
    }
  });

  it("applies nothing under the none scope, whatever the runtime", () => {
    for (const runtime of ["node-24", "bun", "node-22"]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtimes: "none", runtime })).toBe(
        basePodSpec
      );
    }
  });

  it("applies nothing when checkpoints are disabled", () => {
    for (const runtimes of ["none", "node-24-plus", "all"] as const) {
      expect(
        withRunnerSeccompProfile(basePodSpec, { ...base, runtimes, checkpointsEnabled: false })
      ).toBe(basePodSpec);
    }
  });
});

describe("withReservedSourcePorts", () => {
  const reserved = { name: "net.ipv4.ip_local_reserved_ports", value: "50080,50081" };

  it("leaves the spec untouched when unset", () => {
    for (const ports of [undefined, ""]) {
      expect(withReservedSourcePorts(basePodSpec, ports)).toBe(basePodSpec);
    }
  });

  it("adds the sysctl and keeps the rest of the security context", () => {
    expect(withReservedSourcePorts(basePodSpec, "50080,50081")).toEqual({
      ...basePodSpec,
      securityContext: { ...basePodSpec.securityContext, sysctls: [reserved] },
    });
  });

  it("adds a security context when the spec has none", () => {
    expect(withReservedSourcePorts({ restartPolicy: "Never" }, "50080,50081")).toEqual({
      restartPolicy: "Never",
      securityContext: { sysctls: [reserved] },
    });
  });

  it("preserves existing sysctls", () => {
    const existing = { name: "net.ipv4.ip_local_port_range", value: "32768 60999" };
    const podSpec = { ...basePodSpec, securityContext: { sysctls: [existing] } };

    expect(withReservedSourcePorts(podSpec, "50080,50081").securityContext?.sysctls).toEqual([
      existing,
      reserved,
    ]);
  });

  it("replaces an existing value rather than duplicating the name", () => {
    const podSpec = {
      ...basePodSpec,
      securityContext: { sysctls: [{ ...reserved, value: "40000" }] },
    };

    expect(withReservedSourcePorts(podSpec, "50080,50081").securityContext?.sysctls).toEqual([
      reserved,
    ]);
  });
});

describe("runnerSecurityContext", () => {
  it("sets nothing when off", () => {
    expect(runnerSecurityContext("off", 1000, "node-24")).toBeUndefined();
  });

  it("drops all capabilities and blocks escalation at baseline", () => {
    expect(runnerSecurityContext("baseline", 1000, "node-24")).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("pins the configured uid when restricted", () => {
    expect(runnerSecurityContext("restricted", 1000, "node-24")).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 1000,
    });
  });

  it("pins bun's own uid, which differs from node's, for every bun runtime", () => {
    for (const runtime of ["bun", "bun-legacy", "bun-1.4"]) {
      expect(runnerSecurityContext("restricted", 1000, runtime)?.runAsUser).toBe(1001);
    }
  });

  it("falls back to the configured uid when the runtime is unknown", () => {
    for (const runtime of [undefined, null, "", "node", "node-22", "node-26"]) {
      expect(runnerSecurityContext("restricted", 1000, runtime)?.runAsUser).toBe(1000);
    }
  });
});

// The client builds its API objects from a kubeconfig; nothing contacts this cluster.
const kubeconfigDir = await mkdtemp(join(tmpdir(), "supervisor-kubeconfig-"));
process.env.KUBECONFIG = join(kubeconfigDir, "config");
await writeFile(
  process.env.KUBECONFIG,
  [
    "apiVersion: v1",
    "kind: Config",
    "current-context: test",
    "clusters:",
    "- name: test",
    "  cluster:",
    "    server: http://127.0.0.1:1",
    "contexts:",
    "- name: test",
    "  context:",
    "    cluster: test",
    "    user: test",
    "users:",
    "- name: test",
    "  user:",
    "    token: test",
    "",
  ].join("\n")
);

const { KubernetesWorkloadManager } = await import("./kubernetes.js");
const { WorkloadNotCreatedError } = await import("./createErrors.js");

// The manager reads the kubeconfig when it is built.
afterAll(async () => {
  delete process.env.KUBECONFIG;
  await rm(kubeconfigDir, { recursive: true, force: true });
});

/** What client-node raises for a non-2xx answer: the body is the response's raw text. */
function apiError(code: number, message: string) {
  const body = JSON.stringify({ kind: "Status", code, message });
  return new ApiException(code, "Unknown API Status Code!", body, {});
}

const createOptions = {
  image: "registry.example.com/task:1",
  machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
  version: "20261027.1",
  nextAttemptNumber: 1,
  dequeuedAt: new Date(),
  envId: "env_1",
  envType: "PRODUCTION",
  orgId: "org_1",
  projectId: "proj_1",
  deploymentFriendlyId: "deployment_1",
  deploymentVersion: "20261027.1",
  runId: "run1",
  runFriendlyId: "run_1",
  snapshotId: "snapshot1",
  snapshotFriendlyId: "snapshot_1",
} as WorkloadManagerCreateOptions;

/** Creates with a Kubernetes API whose pod create raises `error`; resolves to what create threw. */
async function createFailure(releaseUnstartedRuns: boolean, error: Error): Promise<unknown> {
  const manager = new KubernetesWorkloadManager({
    workloadApiProtocol: "http",
    workloadApiPort: 8020,
    releaseUnstartedRuns,
  });
  let creates = 0;
  const k8s = {
    core: {
      createNamespacedPod: async () => {
        creates++;
        throw error;
      },
    },
  };
  Object.assign(manager, { k8s });
  const thrown = await manager.create(createOptions).then(
    () => "created",
    (thrown: unknown) => thrown
  );
  expect(creates).toBe(1);
  return thrown;
}

describe("KubernetesWorkloadManager create failures", () => {
  it.each([
    ["a quota the namespace has used up", apiError(403, "pods is forbidden: exceeded quota")],
    ["a pod spec the API rejected", apiError(422, "Pod is invalid")],
  ])("reports %s as nothing running, with releases on", async (_name, error) => {
    const thrown = await createFailure(true, error);

    expect(thrown).toBeInstanceOf(WorkloadNotCreatedError);
    expect((thrown as Error).message).toBe(JSON.parse(error.body as string).message);
  });

  it.each([
    ["a name a pod still holds", apiError(409, "pods already exists")],
    ["an answer after which the pod may exist", apiError(500, "etcd leader changed")],
    ["a request the API asked to slow down", apiError(429, "Too many requests")],
  ])("leaves %s to the timeout, with releases on", async (_name, error) => {
    const thrown = await createFailure(true, error);

    expect(thrown).not.toBe("created");
    expect(thrown).not.toBeInstanceOf(WorkloadNotCreatedError);
  });

  it("throws a refusal's raw body as before, with releases off", async () => {
    const error = apiError(403, "pods is forbidden: exceeded quota");

    const thrown = await createFailure(false, error);

    expect(thrown).toBe(error.body);
  });
});
