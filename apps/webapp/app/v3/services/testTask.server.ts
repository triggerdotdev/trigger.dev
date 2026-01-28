import { stringifyIO } from "@trigger.dev/core/v3";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { type TestTaskData } from "../testTask";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";

export class TestTaskService extends BaseService {
  public async call(environment: AuthenticatedEnvironment, data: TestTaskData) {
    const triggerTaskService = new TriggerTaskService();
    const { triggerSource } = data;

    switch (triggerSource) {
      case "STANDARD": {
        const result = await triggerTaskService.call(data.taskIdentifier, environment, {
          payload: data.payload,
          options: {
            test: true,
            metadata: data.metadata,
            delay: data.delaySeconds ? new Date(Date.now() + data.delaySeconds * 1000) : undefined,
            ttl: data.ttlSeconds,
            idempotencyKey: data.idempotencyKey,
            idempotencyKeyTTL: data.idempotencyKeyTTLSeconds
              ? `${data.idempotencyKeyTTLSeconds}s`
              : undefined,
            queue: data.queue ? { name: data.queue } : undefined,
            concurrencyKey: data.concurrencyKey,
            maxAttempts: data.maxAttempts,
            maxDuration: data.maxDurationSeconds,
            tags: data.tags,
            machine: data.machine,
            lockToVersion: data.version === "latest" ? undefined : data.version,
            priority: data.prioritySeconds,
          },
        });

        return result?.run;
      }
      case "SCHEDULED": {
        const payload = {
          scheduleId: "sched_1234",
          type: "IMPERATIVE",
          timestamp: data.timestamp,
          lastTimestamp: data.lastTimestamp,
          timezone: data.timezone,
          externalId: data.externalId,
          upcoming: [],
        };
        const payloadPacket = await stringifyIO(payload);

        const result = await triggerTaskService.call(
          data.taskIdentifier,
          environment,
          {
            payload: payloadPacket.data,
            options: {
              payloadType: payloadPacket.dataType,
              test: true,
              ttl: data.ttlSeconds,
              idempotencyKey: data.idempotencyKey,
              idempotencyKeyTTL: data.idempotencyKeyTTLSeconds
                ? `${data.idempotencyKeyTTLSeconds}s`
                : undefined,
              queue: data.queue ? { name: data.queue } : undefined,
              concurrencyKey: data.concurrencyKey,
              maxAttempts: data.maxAttempts,
              maxDuration: data.maxDurationSeconds,
              tags: data.tags,
              machine: data.machine,
              lockToVersion: data.version === "latest" ? undefined : data.version,
              priority: data.prioritySeconds,
            },
          },
          { customIcon: "scheduled" }
        );

        return result?.run;
      }
      default: {
        triggerSource satisfies never;
        throw new Error("Invalid trigger source");
      }
    }
  }
}
