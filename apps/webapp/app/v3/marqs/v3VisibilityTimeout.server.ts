import { RequeueTaskRunService } from "../requeueTaskRun.server";
import { type VisibilityTimeoutStrategy } from "./types";

export class V3VisibilityTimeout implements VisibilityTimeoutStrategy {
  async heartbeat(messageId: string, timeoutInMs: number): Promise<void> {
    await RequeueTaskRunService.enqueue(messageId, new Date(Date.now() + timeoutInMs));
  }

  async cancelHeartbeat(messageId: string): Promise<void> {
    await RequeueTaskRunService.dequeue(messageId);
  }
}
