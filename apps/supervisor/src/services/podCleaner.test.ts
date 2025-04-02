import { PodCleaner } from "./podCleaner.js";
import { K8sApi, createK8sApi } from "../clients/kubernetes.js";
import { setTimeout } from "timers/promises";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Registry } from "prom-client";

describe("PodCleaner Integration Tests", () => {
  const k8s = createK8sApi();
  const namespace = "integration-test";
  const register = new Registry();

  beforeAll(async () => {
    // Create the test namespace, only if it doesn't exist
    try {
      await k8s.core.readNamespace({ name: namespace });
    } catch (error) {
      await k8s.core.createNamespace({
        body: {
          metadata: {
            name: namespace,
          },
        },
      });
    }
  });

  afterEach(async () => {
    // Clear metrics to avoid conflicts
    register.clear();

    // Delete all pods in the namespace
    await k8s.core.deleteCollectionNamespacedPod({ namespace, gracePeriodSeconds: 0 });
  });

  it("should clean up succeeded pods", async () => {
    const podCleaner = new PodCleaner({ namespace, k8s, register });

    try {
      // Create a test pod that's in succeeded state
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        namePrefix: "test-succeeded-pod",
      });

      if (!podNames[0]) {
        throw new Error("Failed to create test pod");
      }
      const podName = podNames[0];

      // Wait for pod to complete
      await waitForPodPhase({
        k8sApi: k8s,
        namespace,
        podName,
        phase: "Succeeded",
      });

      // Start the pod cleaner
      await podCleaner.start();

      // Wait for pod to be deleted
      await waitForPodDeletion({
        k8sApi: k8s,
        namespace,
        podName,
      });

      // Verify pod was deleted
      expect(await podExists({ k8sApi: k8s, namespace, podName })).toBe(false);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);

  it("should accurately track deletion metrics", async () => {
    const podCleaner = new PodCleaner({ namespace, k8s, register });
    try {
      // Create a test pod that's in succeeded state
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        namePrefix: "test-succeeded-pod",
      });

      // Wait for pod to be in succeeded state
      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Succeeded",
      });

      await podCleaner.start();

      // Wait for pod to be deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      const metrics = podCleaner.getMetrics();
      const deletionCycles = await metrics.deletionCyclesTotal.get();
      const deletionTimestamp = await metrics.lastDeletionTimestamp.get();

      expect(deletionCycles?.values[0]?.value).toBeGreaterThan(0);
      expect(deletionTimestamp?.values[0]?.value).toBeGreaterThan(0);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);

  it("should handle different batch sizes - small", async () => {
    const podCleaner = new PodCleaner({
      namespace,
      k8s,
      register,
      batchSize: 1,
    });

    try {
      // Create some pods that will succeed
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 2,
      });

      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Succeeded",
      });

      await podCleaner.start();

      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      const metrics = podCleaner.getMetrics();
      const cycles = await metrics.deletionCyclesTotal.get();

      expect(cycles?.values[0]?.value).toBe(2);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);

  it("should handle different batch sizes - large", async () => {
    const podCleaner = new PodCleaner({
      namespace,
      k8s,
      register,
      batchSize: 5000,
    });

    try {
      // Create some pods that will succeed
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 10,
      });

      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Succeeded",
      });

      await podCleaner.start();

      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      const metrics = podCleaner.getMetrics();
      const cycles = await metrics.deletionCyclesTotal.get();

      expect(cycles?.values[0]?.value).toBe(1);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);

  it("should not delete pods without app=task-run label", async () => {
    const podCleaner = new PodCleaner({ namespace, k8s, register });

    try {
      // Create a test pod without the task-run label
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        labels: { app: "different-label" },
        namePrefix: "non-task-run-pod",
      });

      if (!podNames[0]) {
        throw new Error("Failed to create test pod");
      }
      const podName = podNames[0];

      // Wait for pod to complete
      await waitForPodPhase({
        k8sApi: k8s,
        namespace,
        podName,
        phase: "Succeeded",
      });

      await podCleaner.start();

      // Wait a reasonable time to ensure pod isn't deleted
      await setTimeout(5000);

      // Verify pod still exists
      expect(await podExists({ k8sApi: k8s, namespace, podName })).toBe(true);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);

  it("should not delete pods that are still running", async () => {
    const podCleaner = new PodCleaner({ namespace, k8s, register });

    try {
      // Create a test pod with a long-running command
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        namePrefix: "running-pod",
        command: ["sleep", "30"], // Will keep pod running
      });

      if (!podNames[0]) {
        throw new Error("Failed to create test pod");
      }
      const podName = podNames[0];

      // Wait for pod to be running
      await waitForPodPhase({
        k8sApi: k8s,
        namespace,
        podName,
        phase: "Running",
      });

      await podCleaner.start();

      // Wait a reasonable time to ensure pod isn't deleted
      await setTimeout(5000);

      // Verify pod still exists
      expect(await podExists({ k8sApi: k8s, namespace, podName })).toBe(true);
    } finally {
      await podCleaner.stop();
    }
  }, 30000);
});

// Helper functions
async function waitForPodPhase({
  k8sApi,
  namespace,
  podName,
  phase,
  timeoutMs = 10000,
  waitMs = 1000,
}: {
  k8sApi: K8sApi;
  namespace: string;
  podName: string;
  phase: string;
  timeoutMs?: number;
  waitMs?: number;
}) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const pod = await k8sApi.core.readNamespacedPod({
      namespace,
      name: podName,
    });
    if (pod.status?.phase === phase) {
      return;
    }
    await setTimeout(waitMs);
  }

  throw new Error(`Pod ${podName} did not reach phase ${phase} within ${timeoutMs}ms`);
}

async function waitForPodDeletion({
  k8sApi,
  namespace,
  podName,
  timeoutMs = 10000,
  waitMs = 1000,
}: {
  k8sApi: K8sApi;
  namespace: string;
  podName: string;
  timeoutMs?: number;
  waitMs?: number;
}) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      await k8sApi.core.readNamespacedPod({
        namespace,
        name: podName,
      });
      await setTimeout(waitMs);
    } catch (error) {
      // Pod was deleted
      return;
    }
  }

  throw new Error(`Pod ${podName} was not deleted within ${timeoutMs}ms`);
}

async function createTestPods({
  k8sApi,
  namespace,
  count,
  labels = { app: "task-run" },
  shouldFail = false,
  namePrefix = "test-pod",
  command = ["/bin/sh", "-c", shouldFail ? "exit 1" : "exit 0"],
}: {
  k8sApi: K8sApi;
  namespace: string;
  count: number;
  labels?: Record<string, string>;
  shouldFail?: boolean;
  namePrefix?: string;
  command?: string[];
}) {
  const createdPods: string[] = [];

  for (let i = 0; i < count; i++) {
    const podName = `${namePrefix}-${i}`;
    await k8sApi.core.createNamespacedPod({
      namespace,
      body: {
        metadata: {
          name: podName,
          labels,
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "test",
              image: "busybox:1.37.0",
              command,
            },
          ],
        },
      },
    });
    createdPods.push(podName);
  }

  return createdPods;
}

async function waitForPodsPhase({
  k8sApi,
  namespace,
  podNames,
  phase,
  timeoutMs = 10000,
  waitMs = 1000,
}: {
  k8sApi: K8sApi;
  namespace: string;
  podNames: string[];
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  timeoutMs?: number;
  waitMs?: number;
}) {
  const startTime = Date.now();
  const pendingPods = new Set(podNames);

  while (pendingPods.size > 0 && Date.now() - startTime < timeoutMs) {
    const pods = await k8sApi.core.listNamespacedPod({ namespace });

    for (const pod of pods.items) {
      if (pendingPods.has(pod.metadata?.name ?? "") && pod.status?.phase === phase) {
        pendingPods.delete(pod.metadata?.name ?? "");
      }
    }

    if (pendingPods.size > 0) {
      await setTimeout(waitMs);
    }
  }

  if (pendingPods.size > 0) {
    throw new Error(
      `Pods [${Array.from(pendingPods).join(
        ", "
      )}] did not reach phase ${phase} within ${timeoutMs}ms`
    );
  }
}

async function waitForPodsDeletion({
  k8sApi,
  namespace,
  podNames,
  timeoutMs = 10000,
  waitMs = 1000,
}: {
  k8sApi: K8sApi;
  namespace: string;
  podNames: string[];
  timeoutMs?: number;
  waitMs?: number;
}) {
  const startTime = Date.now();
  const pendingPods = new Set(podNames);

  while (pendingPods.size > 0 && Date.now() - startTime < timeoutMs) {
    const pods = await k8sApi.core.listNamespacedPod({ namespace });
    const existingPods = new Set(pods.items.map((pod) => pod.metadata?.name ?? ""));

    for (const podName of pendingPods) {
      if (!existingPods.has(podName)) {
        pendingPods.delete(podName);
      }
    }

    if (pendingPods.size > 0) {
      await setTimeout(waitMs);
    }
  }

  if (pendingPods.size > 0) {
    throw new Error(
      `Pods [${Array.from(pendingPods).join(", ")}] were not deleted within ${timeoutMs}ms`
    );
  }
}

async function podExists({
  k8sApi,
  namespace,
  podName,
}: {
  k8sApi: K8sApi;
  namespace: string;
  podName: string;
}) {
  const pods = await k8sApi.core.listNamespacedPod({ namespace });
  return pods.items.some((p) => p.metadata?.name === podName);
}
