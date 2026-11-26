import "./testEnvironment.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../metrics.js";
import { getRunnerId } from "../util.js";
import { KubernetesWorkloadManager } from "./kubernetes.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

const createPod = vi.fn();
const readPod = vi.fn();
const createSecret = vi.fn();
const deleteSecret = vi.fn();
const patchObject = vi.fn();

vi.mock("../clients/kubernetes.js", () => ({
  createK8sApi: () => ({
    core: {
      createNamespacedPod: createPod,
      readNamespacedPod: readPod,
      createNamespacedSecret: createSecret,
      deleteNamespacedSecret: deleteSecret,
    },
    objects: { patch: patchObject },
  }),
}));

const SETTLE_MS = 20;

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

const withToken = { ...createOptions, deploymentToken: "tok_secret" };

const POD_NAME = getRunnerId("run_1", 1);

function manager(podTokenSecretEnabled: boolean) {
  return new KubernetesWorkloadManager({
    workloadApiProtocol: "http",
    workloadApiPort: 8020,
    podTokenSecretEnabled,
    tokenSecretSettleMs: SETTLE_MS,
  });
}

function deploymentIdEntry() {
  const [request] = createPod.mock.calls[0]!;
  return request.body.spec.containers[0].env.find(
    (entry: { name: string }) => entry.name === "TRIGGER_DEPLOYMENT_ID"
  );
}

async function counterValue(name: string): Promise<number> {
  const metric = register.getSingleMetric(name);
  const { values } = await metric!.get();
  return values.find((value) => value.labels.owner === "Pod")?.value ?? 0;
}

function podReferencing(secretName: string) {
  return {
    metadata: { uid: "uid-held" },
    spec: {
      containers: [
        {
          name: "run-controller",
          env: [
            { name: "TRIGGER_DEPLOYMENT_ID", valueFrom: { secretKeyRef: { name: secretName } } },
          ],
        },
      ],
    },
  };
}

describe("KubernetesWorkloadManager deployment token Secret", () => {
  beforeEach(() => {
    createPod.mockReset();
    createPod.mockResolvedValue({ metadata: { uid: "uid-pod" } });
    readPod.mockReset();
    createSecret.mockReset();
    createSecret.mockResolvedValue({ metadata: { uid: "uid-secret", resourceVersion: "7" } });
    deleteSecret.mockReset();
    deleteSecret.mockResolvedValue({});
    patchObject.mockReset();
    patchObject.mockResolvedValue({});
  });

  it("keeps the token as a literal value and writes no Secret when the flag is off", async () => {
    await manager(false).create(withToken);

    expect(deploymentIdEntry()).toEqual({ name: "TRIGGER_DEPLOYMENT_ID", value: "tok_secret" });
    expect(createSecret).not.toHaveBeenCalled();
    expect(patchObject).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(readPod).not.toHaveBeenCalled();
  });

  it("writes the Secret before the pod, references it, and hands it to the pod", async () => {
    await manager(true).create(withToken);

    expect(createSecret.mock.invocationCallOrder[0]).toBeLessThan(
      createPod.mock.invocationCallOrder[0]!
    );
    const [secretRequest] = createSecret.mock.calls[0]!;
    const secretName = secretRequest.body.metadata.name;
    expect(secretName).toMatch(new RegExp(`^${POD_NAME}-token-[0-9a-f]{8}$`));
    expect(secretRequest.body).toMatchObject({
      type: "Opaque",
      immutable: true,
      stringData: { token: "tok_secret" },
      metadata: {
        labels: {
          "app.kubernetes.io/part-of": "trigger-worker",
          "app.kubernetes.io/component": "runner-token",
        },
      },
    });
    expect(secretRequest.body.metadata.ownerReferences).toBeUndefined();

    expect(deploymentIdEntry()).toEqual({
      name: "TRIGGER_DEPLOYMENT_ID",
      valueFrom: { secretKeyRef: { name: secretName, key: "token" } },
    });

    const [object] = patchObject.mock.calls[0]!;
    expect(object.metadata).toMatchObject({
      name: secretName,
      ownerReferences: [{ apiVersion: "v1", kind: "Pod", uid: "uid-pod" }],
    });
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("names a new Secret on every create", async () => {
    const lane = manager(true);
    await lane.create(withToken);
    await lane.create(withToken);

    const names = createSecret.mock.calls.map(([request]) => request.body.metadata.name);
    expect(new Set(names).size).toBe(2);
  });

  it("keeps a bare deployment id as a literal value with no Secret", async () => {
    await manager(true).create(createOptions);

    expect(deploymentIdEntry()).toEqual({ name: "TRIGGER_DEPLOYMENT_ID", value: "deployment_1" });
    expect(createSecret).not.toHaveBeenCalled();
    expect(patchObject).not.toHaveBeenCalled();
  });

  it("does not create the pod when the Secret cannot be written", async () => {
    const err = { code: 500 };
    createSecret.mockRejectedValue(err);

    await expect(manager(true).create(withToken)).rejects.toBe(err);

    expect(createPod).not.toHaveBeenCalled();
  });

  it.each([
    ["a 503", { code: 503 }],
    ["a socket error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
  ])("counts a Secret create that fails with %s", async (_, err) => {
    createSecret.mockRejectedValue(err);
    const before = await counterValue("supervisor_token_secret_create_unclear_total");

    await expect(manager(true).create(withToken)).rejects.toBe(err);

    expect(await counterValue("supervisor_token_secret_create_unclear_total")).toBe(before + 1);
  });

  it("does not count a Secret create the API refused", async () => {
    createSecret.mockRejectedValue({ code: 403 });
    const before = await counterValue("supervisor_token_secret_create_unclear_total");

    await expect(manager(true).create(withToken)).rejects.toMatchObject({ code: 403 });

    expect(await counterValue("supervisor_token_secret_create_unclear_total")).toBe(before);
  });

  it("deletes the Secret under its uid after the settle delay when no pod shows", async () => {
    const err = { code: 503 };
    createPod.mockRejectedValue(err);
    readPod.mockRejectedValue({ code: 404 });

    await expect(manager(true).create(withToken)).rejects.toBe(err);

    expect(readPod).toHaveBeenCalledTimes(1);
    expect(deleteSecret).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteSecret).toHaveBeenCalled());
    expect(readPod).toHaveBeenCalledTimes(2);
    expect(deleteSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { preconditions: { uid: "uid-secret", resourceVersion: "7" } },
      })
    );
    expect(patchObject).not.toHaveBeenCalled();
  });

  it("is adopted by a pod that took the name and references the Secret", async () => {
    createPod.mockRejectedValue({ code: 409 });
    readPod.mockImplementation(async () =>
      podReferencing(createSecret.mock.calls[0]![0].body.metadata.name)
    );

    await expect(manager(true).create(withToken)).rejects.toMatchObject({ code: 409 });

    expect(deleteSecret).not.toHaveBeenCalled();
    const [object] = patchObject.mock.calls[0]!;
    expect(object.metadata.ownerReferences).toEqual([
      { apiVersion: "v1", kind: "Pod", name: POD_NAME, uid: "uid-held" },
    ]);
  });

  it("rewrites the Secret, owned, when the adoption patch finds it gone", async () => {
    patchObject.mockRejectedValue({ code: 404 });

    await manager(true).create(withToken);

    expect(createSecret).toHaveBeenCalledTimes(2);
    const [first] = createSecret.mock.calls[0]!;
    const [rewrite] = createSecret.mock.calls[1]!;
    expect(rewrite.body.metadata.name).toBe(first.body.metadata.name);
    expect(rewrite.body.stringData).toEqual({ token: "tok_secret" });
    expect(rewrite.body.metadata.ownerReferences).toEqual([
      expect.objectContaining({ kind: "Pod", uid: "uid-pod" }),
    ]);
  });

  it("does not fail the run when adoption fails, and counts it", async () => {
    patchObject.mockRejectedValue({ code: 500 });
    const before = await counterValue("supervisor_token_secret_adoption_failures_total");

    await expect(manager(true).create(withToken)).resolves.toBeUndefined();

    expect(await counterValue("supervisor_token_secret_adoption_failures_total")).toBe(before + 1);
  });

  it("counts a cleanup that fails", async () => {
    createPod.mockRejectedValue({ code: 503 });
    readPod.mockResolvedValue(podReferencing(`${POD_NAME}-token-other`));
    deleteSecret.mockRejectedValue({ code: 500 });
    const before = await counterValue("supervisor_token_secret_cleanup_failures_total");

    await expect(manager(true).create(withToken)).rejects.toMatchObject({ code: 503 });

    await vi.waitFor(async () =>
      expect(await counterValue("supervisor_token_secret_cleanup_failures_total")).toBe(before + 1)
    );
  });

  it.each([
    ["a timeout", { code: 504 }],
    ["a 5xx", { code: 500 }],
    ["a connection reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
  ])(
    "is adopted after %s when a pod of another Secret gives way to one referencing it",
    async (_, err) => {
      createPod.mockRejectedValue(err);
      readPod
        .mockResolvedValueOnce(podReferencing(`${POD_NAME}-token-other`))
        .mockImplementation(async () =>
          podReferencing(createSecret.mock.calls[0]![0].body.metadata.name)
        );

      await expect(manager(true).create(withToken)).rejects.toBe(err);

      expect(deleteSecret).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(patchObject).toHaveBeenCalled());
      expect(readPod).toHaveBeenCalledTimes(2);
      expect(deleteSecret).not.toHaveBeenCalled();
    }
  );

  it("is deleted after the settle delay when an unclear error leaves a pod of another Secret", async () => {
    createPod.mockRejectedValue({ code: 503 });
    readPod.mockResolvedValue(podReferencing(`${POD_NAME}-token-other`));

    await expect(manager(true).create(withToken)).rejects.toMatchObject({ code: 503 });

    expect(deleteSecret).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteSecret).toHaveBeenCalled());
    expect(readPod).toHaveBeenCalledTimes(2);
    expect(deleteSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { preconditions: { uid: "uid-secret", resourceVersion: "7" } },
      })
    );
    expect(patchObject).not.toHaveBeenCalled();
  });

  it.each([409, 422, 403])(
    "is deleted at once when the API rejected the create with %s and a pod of another Secret holds the name",
    async (code) => {
      createPod.mockRejectedValue({ code });
      readPod.mockResolvedValue(podReferencing(`${POD_NAME}-token-other`));

      await expect(manager(true).create(withToken)).rejects.toMatchObject({ code });

      expect(readPod).toHaveBeenCalledTimes(1);
      expect(deleteSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { preconditions: { uid: "uid-secret", resourceVersion: "7" } },
        })
      );
      expect(patchObject).not.toHaveBeenCalled();
    }
  );
});
