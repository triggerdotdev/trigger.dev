import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { FailedPodHandler } from "./failedPodHandler.js";
import { K8sApi, createK8sApi } from "../clients/kubernetes.js";
import { Registry } from "prom-client";
import { setTimeout } from "timers/promises";

describe("FailedPodHandler Integration Tests", () => {
  const k8s = createK8sApi();
  const namespace = "integration-test";
  const register = new Registry();

  beforeAll(async () => {
    // Create the test namespace if it doesn't exist
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

    // Clear any existing pods in the namespace
    await deleteAllPodsInNamespace({ k8sApi: k8s, namespace });
  });

  afterEach(async () => {
    // Clear metrics to avoid conflicts
    register.clear();

    // Delete any remaining pods in the namespace
    await deleteAllPodsInNamespace({ k8sApi: k8s, namespace });
  });

  it("should process and delete failed pods with app=task-run label", async () => {
    const handler = new FailedPodHandler({ namespace, k8s, register });

    try {
      // Create failed pods with the correct label
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 2,
        shouldFail: true,
      });

      // Wait for pods to reach Failed state
      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Failed",
      });

      // Start the handler
      await handler.start();

      // Wait for pods to be deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      // Verify metrics
      const metrics = handler.getMetrics();

      // Check informer events were recorded
      const informerEvents = await metrics.informerEventsTotal.get();
      expect(informerEvents.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "add",
          }),
          value: 2,
        })
      );
      expect(informerEvents.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "connect",
          }),
          value: 1,
        })
      );
      expect(informerEvents.values).not.toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "error",
          }),
        })
      );

      // Check pods were processed
      const processedPods = await metrics.processedPodsTotal.get();
      expect(processedPods.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            status: "Failed",
          }),
          value: 2,
        })
      );

      // Check pods were deleted
      const deletedPods = await metrics.deletedPodsTotal.get();
      expect(deletedPods.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            status: "Failed",
          }),
          value: 2,
        })
      );

      // Check no deletion errors were recorded
      const deletionErrors = await metrics.deletionErrorsTotal.get();
      expect(deletionErrors.values).toHaveLength(0);

      // Check processing durations were recorded
      const durations = await metrics.processingDurationSeconds.get();
      const failedDurations = durations.values.filter(
        (v) => v.labels.namespace === namespace && v.labels.status === "Failed"
      );
      expect(failedDurations.length).toBeGreaterThan(0);
    } finally {
      await handler.stop();
    }
  }, 30000);

  it("should ignore pods without app=task-run label", async () => {
    const handler = new FailedPodHandler({ namespace, k8s, register });

    try {
      // Create failed pods without the task-run label
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        shouldFail: true,
        labels: { app: "not-task-run" },
      });

      // Wait for pod to reach Failed state
      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Failed",
      });

      await handler.start();

      // Wait a reasonable time to ensure pod isn't deleted
      await setTimeout(5000);

      // Verify pod still exists
      const exists = await podExists({ k8sApi: k8s, namespace, podName: podNames[0]! });
      expect(exists).toBe(true);

      // Verify no metrics were recorded
      const metrics = handler.getMetrics();
      const processedPods = await metrics.processedPodsTotal.get();
      expect(processedPods.values).toHaveLength(0);
    } finally {
      await handler.stop();
    }
  }, 30000);

  it("should not process pods that are being deleted", async () => {
    const handler = new FailedPodHandler({ namespace, k8s, register });

    try {
      // Create a failed pod that we'll mark for deletion
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 1,
        shouldFail: true,
        command: ["/bin/sh", "-c", "sleep 30"],
      });

      // Wait for pod to reach Failed state
      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames,
        phase: "Running",
      });

      // Delete the pod but don't wait for deletion
      await k8s.core.deleteNamespacedPod({
        namespace,
        name: podNames[0]!,
        gracePeriodSeconds: 5,
      });

      // Start the handler
      await handler.start();

      // Wait for pod to be fully deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      // Verify metrics show we skipped processing
      const metrics = handler.getMetrics();
      const processedPods = await metrics.processedPodsTotal.get();
      expect(processedPods.values).toHaveLength(0);
    } finally {
      await handler.stop();
    }
  }, 30000);

  it("should detect and process pods that fail after handler starts", async () => {
    const handler = new FailedPodHandler({ namespace, k8s, register });

    try {
      // Start the handler
      await handler.start();

      // Create failed pods with the correct label
      const podNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 3,
        shouldFail: true,
      });

      // Wait for pods to be deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames,
      });

      // Verify metrics
      const metrics = handler.getMetrics();

      // Check informer events were recorded
      const informerEvents = await metrics.informerEventsTotal.get();
      expect(informerEvents.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "add",
          }),
          value: 3,
        })
      );
      expect(informerEvents.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "connect",
          }),
          value: 1,
        })
      );
      expect(informerEvents.values).not.toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "error",
          }),
        })
      );

      // Check pods were processed
      const processedPods = await metrics.processedPodsTotal.get();
      expect(processedPods.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            status: "Failed",
          }),
          value: 3,
        })
      );

      // Check pods were deleted
      const deletedPods = await metrics.deletedPodsTotal.get();
      expect(deletedPods.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            status: "Failed",
          }),
          value: 3,
        })
      );

      // Check no deletion errors were recorded
      const deletionErrors = await metrics.deletionErrorsTotal.get();
      expect(deletionErrors.values).toHaveLength(0);

      // Check processing durations were recorded
      const durations = await metrics.processingDurationSeconds.get();
      const failedDurations = durations.values.filter(
        (v) => v.labels.namespace === namespace && v.labels.status === "Failed"
      );
      expect(failedDurations.length).toBeGreaterThan(0);
    } finally {
      await handler.stop();
    }
  }, 60000);

  it("should handle graceful shutdown pods differently", async () => {
    const handler = new FailedPodHandler({ namespace, k8s, register });

    try {
      // Create first batch of pods before starting handler
      const firstBatchPodNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 2,
        exitCode: FailedPodHandler.GRACEFUL_SHUTDOWN_EXIT_CODE,
      });

      // Wait for pods to reach Failed state
      await waitForPodsPhase({
        k8sApi: k8s,
        namespace,
        podNames: firstBatchPodNames,
        phase: "Failed",
      });

      // Start the handler
      await handler.start();

      // Wait for first batch to be deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames: firstBatchPodNames,
      });

      // Create second batch of pods after handler is running
      const secondBatchPodNames = await createTestPods({
        k8sApi: k8s,
        namespace,
        count: 3,
        exitCode: FailedPodHandler.GRACEFUL_SHUTDOWN_EXIT_CODE,
      });

      // Wait for second batch to be deleted
      await waitForPodsDeletion({
        k8sApi: k8s,
        namespace,
        podNames: secondBatchPodNames,
      });

      // Verify metrics
      const metrics = handler.getMetrics();

      // Check informer events were recorded for both batches
      const informerEvents = await metrics.informerEventsTotal.get();
      expect(informerEvents.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            verb: "add",
          }),
          value: 5, // 2 from first batch + 3 from second batch
        })
      );

      // Check pods were processed as graceful shutdowns
      const processedPods = await metrics.processedPodsTotal.get();

      // Should not be marked as Failed
      const failedPods = processedPods.values.find(
        (v) => v.labels.namespace === namespace && v.labels.status === "Failed"
      );
      expect(failedPods).toBeUndefined();

      // Should be marked as GracefulShutdown
      const gracefulShutdowns = processedPods.values.find(
        (v) => v.labels.namespace === namespace && v.labels.status === "GracefulShutdown"
      );
      expect(gracefulShutdowns).toBeDefined();
      expect(gracefulShutdowns?.value).toBe(5); // Total from both batches

      // Check pods were still deleted
      const deletedPods = await metrics.deletedPodsTotal.get();
      expect(deletedPods.values).toContainEqual(
        expect.objectContaining({
          labels: expect.objectContaining({
            namespace,
            status: "Failed",
          }),
          value: 5, // Total from both batches
        })
      );

      // Check no deletion errors were recorded
      const deletionErrors = await metrics.deletionErrorsTotal.get();
      expect(deletionErrors.values).toHaveLength(0);
    } finally {
      await handler.stop();
    }
  }, 30000);
});

async function createTestPods({
  k8sApi,
  namespace,
  count,
  labels = { app: "task-run" },
  shouldFail = false,
  namePrefix = "test-pod",
  command = ["/bin/sh", "-c", shouldFail ? "exit 1" : "exit 0"],
  randomizeName = true,
  exitCode,
}: {
  k8sApi: K8sApi;
  namespace: string;
  count: number;
  labels?: Record<string, string>;
  shouldFail?: boolean;
  namePrefix?: string;
  command?: string[];
  randomizeName?: boolean;
  exitCode?: number;
}) {
  const createdPods: string[] = [];

  // If exitCode is specified, override the command
  if (exitCode !== undefined) {
    command = ["/bin/sh", "-c", `exit ${exitCode}`];
  }

  for (let i = 0; i < count; i++) {
    const podName = randomizeName
      ? `${namePrefix}-${i}-${Math.random().toString(36).substring(2, 15)}`
      : `${namePrefix}-${i}`;
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
              name: "run-controller", // Changed to match the name we check in failedPodHandler
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

async function deleteAllPodsInNamespace({
  k8sApi,
  namespace,
}: {
  k8sApi: K8sApi;
  namespace: string;
}) {
  // Get all pods
  const pods = await k8sApi.core.listNamespacedPod({ namespace });
  const podNames = pods.items.map((p) => p.metadata?.name ?? "");

  // Delete all pods
  await k8sApi.core.deleteCollectionNamespacedPod({ namespace, gracePeriodSeconds: 0 });

  // Wait for all pods to be deleted
  await waitForPodsDeletion({ k8sApi, namespace, podNames });
}
