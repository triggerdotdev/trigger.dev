import type { TaskRunExecutionMetrics } from "@trigger.dev/core/v3";

export function measureExecutionMetrics({
  attemptCreatedAt,
  dequeuedAt,
  podScheduledAt,
  supervisorWait,
}: {
  attemptCreatedAt: number;
  dequeuedAt?: number;
  podScheduledAt?: number;
  supervisorWait?: { startedAt: number; durationMs: number };
}): TaskRunExecutionMetrics {
  const metrics: TaskRunExecutionMetrics = [
    {
      name: "start",
      event: "create_attempt",
      timestamp: attemptCreatedAt,
      duration: Date.now() - attemptCreatedAt,
    },
  ];

  if (dequeuedAt) {
    metrics.push({
      name: "start",
      event: "dequeue",
      timestamp: dequeuedAt,
      duration: 0,
    });
  }

  if (podScheduledAt) {
    metrics.push({
      name: "start",
      event: "pod_scheduled",
      timestamp: podScheduledAt,
      duration: 0,
    });
  }

  if (supervisorWait) {
    metrics.push({
      name: "start",
      event: "supervisor_wait",
      timestamp: supervisorWait.startedAt,
      duration: supervisorWait.durationMs,
    });
  }

  return metrics;
}
