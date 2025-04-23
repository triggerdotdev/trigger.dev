import { legacyRunEngineWorker } from "../legacyRunEngineWorker.server";
import { TaskRunHeartbeatFailedService } from "../taskRunHeartbeatFailed.server";
import { VisibilityTimeoutStrategy } from "./types";

export class V3GraphileVisibilityTimeout implements VisibilityTimeoutStrategy {
  async startHeartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    await TaskRunHeartbeatFailedService.enqueue(messageId, new Date(Date.now() + timeoutInMs));
  }

  async heartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    await TaskRunHeartbeatFailedService.enqueue(messageId, new Date(Date.now() + timeoutInMs));
  }

  async cancelHeartbeat(messageId: string): Promise<void> {
    await TaskRunHeartbeatFailedService.dequeue(messageId);
  }
}

export class V3LegacyRunEngineWorkerVisibilityTimeout implements VisibilityTimeoutStrategy {
  async startHeartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    await legacyRunEngineWorker.enqueue({
      id: `heartbeat:${messageId}`,
      job: "runHeartbeat",
      payload: { runId: messageId },
      availableAt: new Date(Date.now() + timeoutInMs),
    });
  }

  async heartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    await legacyRunEngineWorker.reschedule(
      `heartbeat:${messageId}`,
      new Date(Date.now() + timeoutInMs)
    );
  }

  async cancelHeartbeat(messageId: string): Promise<void> {
    await legacyRunEngineWorker.ack(`heartbeat:${messageId}`);
  }
}
